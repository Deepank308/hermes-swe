import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";
import type { SessionRecord } from "./types.js";

const LOCAL_PATH = "sessions-local.json";

interface SessionsFile {
  sessions: Record<string, SessionRecord>;
}

const s3 = config.dryRun ? null : new S3Client({ region: config.awsRegion });

// --- In-memory cache, loaded once from S3 on first access ---

let cache: SessionsFile | null = null;

// Simple async mutex to prevent concurrent read-modify-write
let lock: Promise<void> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = lock.then(fn, fn);
  lock = next.then(
    () => {},
    () => {},
  );
  return next;
}

async function loadFromS3(): Promise<SessionsFile> {
  if (config.dryRun) {
    try {
      const data = readFileSync(LOCAL_PATH, "utf-8");
      return JSON.parse(data) as SessionsFile;
    } catch {
      return { sessions: {} };
    }
  }

  try {
    const resp = await s3!.send(
      new GetObjectCommand({
        Bucket: config.sessionsBucket,
        Key: config.sessionsKey,
      }),
    );
    const body = await resp.Body?.transformToString();
    if (!body) return { sessions: {} };
    return JSON.parse(body) as SessionsFile;
  } catch (err) {
    const code = (err as { name?: string }).name;
    if (code === "NoSuchKey" || code === "NoSuchBucket") {
      return { sessions: {} };
    }
    throw err;
  }
}

/** Get the cached data, loading from S3 on first access. */
async function getData(): Promise<SessionsFile> {
  if (!cache) {
    cache = await loadFromS3();
  }
  return cache;
}

/** Persist the cache to S3 (production) and optionally to local file. */
async function persist(): Promise<void> {
  if (!cache) return;
  const json = JSON.stringify(cache, null, 2);

  if (!config.dryRun) {
    await s3!.send(
      new PutObjectCommand({
        Bucket: config.sessionsBucket,
        Key: config.sessionsKey,
        Body: json,
        ContentType: "application/json",
      }),
    );
  }

  if (config.localLogging) {
    try {
      mkdirSync(dirname(LOCAL_PATH), { recursive: true });
      writeFileSync(LOCAL_PATH, json);
    } catch {
      // non-critical
    }
  }
}

// --- Public API ---

export function create(record: SessionRecord): Promise<void> {
  return withLock(async () => {
    const data = await getData();
    data.sessions[record.agentSessionId] = record;
    await persist();
  });
}

export function get(
  agentSessionId: string,
): Promise<SessionRecord | undefined> {
  return withLock(async () => {
    const data = await getData();
    return data.sessions[agentSessionId];
  });
}

export function update(
  agentSessionId: string,
  updates: Partial<SessionRecord>,
): Promise<SessionRecord | undefined> {
  return withLock(async () => {
    const data = await getData();
    const existing = data.sessions[agentSessionId];
    if (!existing) return undefined;

    const updated = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    data.sessions[agentSessionId] = updated;
    await persist();
    return updated;
  });
}

export function getAll(): Promise<SessionRecord[]> {
  return withLock(async () => {
    const data = await getData();
    return Object.values(data.sessions);
  });
}

export function getActiveCount(): Promise<number> {
  return withLock(async () => {
    const data = await getData();
    return Object.values(data.sessions).filter(
      (s) => s.status === "provisioning" || s.status === "running",
    ).length;
  });
}

export function getNextQueued(): Promise<SessionRecord | undefined> {
  return withLock(async () => {
    const data = await getData();
    const queued = Object.values(data.sessions)
      .filter((s) => s.status === "queued")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return queued[0];
  });
}

/**
 * Find a session by its agentSessionUrl (the Linear agent session URL).
 */
export function findByUrl(
  agentSessionUrl: string,
): Promise<SessionRecord | undefined> {
  return withLock(async () => {
    const data = await getData();
    return Object.values(data.sessions).find(
      (s) => s.agentSessionUrl === agentSessionUrl,
    );
  });
}

/**
 * Generate a pre-signed URL to download Claude projects artifacts for a session.
 * Returns undefined if no artifacts exist for this session.
 */
export async function getArtifactsUrl(
  agentSessionId: string,
): Promise<string | undefined> {
  if (config.dryRun) {
    console.log(
      `[store:artifacts] DRY RUN: Would look up artifacts for ${agentSessionId}`,
    );
    return undefined;
  }

  const key = `sessions/${agentSessionId}/claude-projects.tar.gz`;

  try {
    // Check if artifacts exist
    await s3!.send(
      new HeadObjectCommand({ Bucket: config.sessionsBucket, Key: key }),
    );
  } catch {
    return undefined;
  }

  const url = await getSignedUrl(
    s3!,
    new GetObjectCommand({ Bucket: config.sessionsBucket, Key: key }),
    { expiresIn: config.artifactsUrlExpiry },
  );
  return url;
}
