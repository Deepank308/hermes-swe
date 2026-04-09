import { mkdirSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import Fastify from "fastify";
import { LinearWebhookClient } from "@linear/sdk/webhooks";
import type { AgentSessionEventWebhookPayload } from "@linear/sdk";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { config, loadSecrets, getRepoConfig } from "./config.js";
import {
  handleSessionCreated,
  handleSessionPrompted,
} from "./webhook-handler.js";
import { sessionManager } from "./session-manager.js";
import { exchangeCode } from "./linear-token.js";
import { getSecrets } from "./secrets.js";
import { generateGitHubToken } from "./github-token.js";
import * as sessionStore from "./session-store.js";
import { notifySlack } from "./slack.js";
import { cleanupExpiredSnapshots } from "./ec2.js";
import type { CompletionCallback } from "./types.js";

const s3 = config.dryRun ? null : new S3Client({ region: config.awsRegion });

if (config.dryRun) {
  console.log(
    "[orchestrator:start] DRY RUN mode — AWS calls are mocked, sessions stored locally",
  );
}

// Load secrets before starting the server
const secrets = await getSecrets();
await loadSecrets(secrets);

// --- Public server (port 3001): webhooks, OAuth, health ---
const app = Fastify({ logger: false });

// Log every incoming request with webhook type/action when available
app.addHook("preHandler", (request, _reply, done) => {
  const body = request.body as { type?: string; action?: string } | undefined;
  const details = body?.type ? ` type=${body.type} action=${body.action}` : "";
  console.log(
    `[http:request] ${request.method} ${request.url}${details} → ${request.ip}`,
  );
  done();
});

// --- Internal server (port 3002): agent-facing routes ---
const internalApp = Fastify({ logger: false, bodyLimit: 50 * 1024 * 1024 }); // 50MB for artifacts

// Register raw body parser for gzip uploads
internalApp.addContentTypeParser(
  "application/gzip",
  { parseAs: "buffer" },
  (_req, body, done) => {
    done(null, body);
  },
);

internalApp.addHook("preHandler", (request, _reply, done) => {
  console.log(`[http:internal] ${request.method} ${request.url} → ${request.ip}`);
  done();
});

// --- Webhook route ---
const webhookClient = new LinearWebhookClient(
  config.secrets.LINEAR_WEBHOOK_SECRET,
);

// --- Webhook logging per agent session (local disk, off by default in production) ---
let webhookLogDir: string | null = null;
if (config.localLogging) {
  webhookLogDir = resolve(import.meta.dirname, "../.logs/webhooks");
  mkdirSync(webhookLogDir, { recursive: true });
}

function logWebhookEvent(
  agentSessionId: string,
  eventType: string,
  event: unknown,
): void {
  if (!webhookLogDir) return;
  const entry = { timestamp: new Date().toISOString(), eventType, event };
  const logFile = resolve(webhookLogDir, `${agentSessionId}.jsonl`);
  try {
    appendFileSync(logFile, JSON.stringify(entry) + "\n");
  } catch (err) {
    console.warn(
      "[webhook:log] Failed to write:",
      err instanceof Error ? err.message : err,
    );
  }
}

// Encapsulated plugin so the raw-body content parser only applies to /webhook
app.register(async function webhookRoute(instance) {
  instance.removeContentTypeParser("application/json");
  instance.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_req, body, done) => {
      done(null, body);
    },
  );

  instance.post("/webhook", async (request, reply) => {
    const signature = request.headers["linear-signature"] as string | undefined;
    if (!signature) {
      return reply.status(401).send({ error: "Missing signature" });
    }

    const rawBody = request.body as Buffer;

    let event: AgentSessionEventWebhookPayload;
    try {
      const payload = webhookClient.parseData(rawBody, signature);
      if (payload.type !== "AgentSessionEvent") {
        return reply.send({ ok: true });
      }
      event = payload as AgentSessionEventWebhookPayload;
    } catch {
      return reply.status(401).send({ error: "Signature verification failed" });
    }

    const agentSessionId = event.agentSession.id;

    if (event.action === "created") {
      logWebhookEvent(agentSessionId, "session_created", event);
      handleSessionCreated(event).catch((err) => {
        console.error("[orchestrator] handleSessionCreated error:", err);
      });
    } else if (event.action === "prompted") {
      logWebhookEvent(agentSessionId, "session_prompted", event);
      handleSessionPrompted(event).catch((err) => {
        console.error("[orchestrator] handleSessionPrompted error:", err);
      });
    }

    return reply.send({ ok: true });
  });
});

// --- Internal routes (agent-facing) ---
const VALID_CALLBACK_STATUSES = new Set(["completed", "failed", "stopped"]);

internalApp.post("/agent-ready", async (request, reply) => {
  const { agentSessionId } = request.body as { agentSessionId?: string };
  if (!agentSessionId) {
    return reply
      .status(400)
      .send({ ok: false, error: "Missing agentSessionId" });
  }

  sessionManager.handleAgentReady(agentSessionId).catch((err) => {
    console.error("[orchestrator] handleAgentReady error:", err);
  });

  return reply.send({ ok: true });
});

internalApp.post("/callback", async (request, reply) => {
  const callback = request.body as CompletionCallback;
  if (!callback.agentSessionId || !callback.status) {
    return reply
      .status(400)
      .send({ ok: false, error: "Missing agentSessionId or status" });
  }
  if (!VALID_CALLBACK_STATUSES.has(callback.status)) {
    return reply.status(400).send({ ok: false, error: "Invalid status" });
  }

  sessionManager.handleCompletion(callback).catch((err) => {
    console.error("[orchestrator] handleCompletion error:", err);
  });

  return reply.send({ ok: true });
});

internalApp.post("/session-update", async (request, reply) => {
  const body = request.body as {
    agentSessionId?: string;
    claudeSessionId?: string;
  };
  if (!body.agentSessionId || !body.claudeSessionId) {
    return reply
      .status(400)
      .send({ ok: false, error: "Missing agentSessionId or claudeSessionId" });
  }

  await sessionStore.update(body.agentSessionId, {
    claudeSessionId: body.claudeSessionId,
  });
  console.log(
    `[orchestrator] Session ${body.agentSessionId} → claude ${body.claudeSessionId}`,
  );
  return reply.send({ ok: true });
});

internalApp.post("/session-waiting", async (request, reply) => {
  const { agentSessionId, header } = request.body as {
    agentSessionId?: string;
    header?: string;
  };
  if (!agentSessionId) {
    return reply
      .status(400)
      .send({ ok: false, error: "Missing agentSessionId" });
  }

  const topic = header ? `: ${header}` : "";
  notifySlack(agentSessionId, `Agent needs your input${topic}`, {
    mention: true,
  });

  return reply.send({ ok: true });
});

internalApp.post("/session-preview-url", async (request, reply) => {
  const { agentSessionId, previewUrl, label } = request.body as {
    agentSessionId?: string;
    previewUrl?: string;
    label?: string;
  };
  if (!agentSessionId || !previewUrl) {
    return reply
      .status(400)
      .send({ ok: false, error: "Missing agentSessionId or previewUrl" });
  }

  const session = await sessionStore.get(agentSessionId);
  if (!session) {
    return reply.status(404).send({ ok: false, error: "Session not found" });
  }

  // Append to preview URLs array (deduplicated by URL)
  const existing = session.previewUrls ?? [];
  if (!existing.some((e) => e.url === previewUrl)) {
    const entry = { url: previewUrl, label: label ?? "App" };
    await sessionStore.update(agentSessionId, {
      previewUrls: [...existing, entry],
    });
    notifySlack(agentSessionId, `Preview (${entry.label}): ${previewUrl}`);
    console.log(
      `[orchestrator] Preview URL for ${agentSessionId}: ${previewUrl} (${entry.label})`,
    );
  }

  return reply.send({ ok: true });
});

internalApp.post("/session-artifacts", async (request, reply) => {
  const agentSessionId =
    (request.headers["x-agent-session-id"] as string) ?? "";
  if (!agentSessionId) {
    return reply
      .status(400)
      .send({ ok: false, error: "Missing x-agent-session-id header" });
  }

  const rawBody = request.body as Buffer;
  if (!rawBody || !rawBody.length) {
    return reply.status(400).send({ ok: false, error: "Empty body" });
  }

  const key = `sessions/${agentSessionId}/claude-projects.tar.gz`;

  if (config.dryRun) {
    console.log(
      `[orchestrator] DRY RUN: Would store ${rawBody.length} bytes of artifacts for ${agentSessionId}`,
    );
  } else {
    await s3!.send(
      new PutObjectCommand({
        Bucket: config.sessionsBucket,
        Key: key,
        Body: rawBody,
        ContentType: "application/gzip",
      }),
    );
    console.log(
      `[orchestrator] Stored artifacts for ${agentSessionId} → s3://${config.sessionsBucket}/${key}`,
    );
  }
  return reply.send({ ok: true });
});

// --- Public routes ---

app.get("/health", async (_request, reply) => {
  return reply.send({ ok: true });
});

// --- GitHub App token refresh (called by agent-service) ---

internalApp.get("/github-refresh-token", async (_request, reply) => {
  try {
    const { token, expiresAt } = await generateGitHubToken();
    return reply.send({ ok: true, data: { token, expiresAt } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[github:refresh] Failed: ${msg}`);
    return reply.status(500).send({ ok: false, error: msg });
  }
});

// --- Teleport: download cloud session to local CLI ---

app.get("/teleport", async (request, reply) => {
  const { url, id } = request.query as { url?: string; id?: string };
  if (!url && !id) {
    return reply
      .status(400)
      .send({ ok: false, error: "Missing ?url= or ?id= parameter" });
  }

  const session = id
    ? await sessionStore.get(id)
    : await sessionStore.findByUrl(url!);
  if (!session) {
    return reply.status(404).send({ ok: false, error: "No session found" });
  }

  if (!session.claudeSessionId) {
    return reply.status(400).send({
      ok: false,
      error: "Session has no Claude session ID (never ran successfully)",
    });
  }

  const artifactsUrl = await sessionStore.getArtifactsUrl(
    session.agentSessionId,
  );
  if (!artifactsUrl) {
    return reply.status(404).send({
      ok: false,
      error:
        "No artifacts found for this session (may have failed before uploading)",
    });
  }

  const repoConfig = getRepoConfig(session.repo);

  return reply.send({
    ok: true,
    agentSessionId: session.agentSessionId,
    claudeSessionId: session.claudeSessionId,
    branch: session.branch,
    repo: session.repo,
    workspaceDir: repoConfig.workspaceDir,
    issueIdentifier: session.issueIdentifier,
    issueTitle: session.issueTitle,
    status: session.status,
    artifactsUrl,
  });
});

// --- OAuth app installation ---

app.get("/oauth/install", async (_request, reply) => {
  const params = new URLSearchParams({
    client_id: config.secrets.LINEAR_CLIENT_ID,
    redirect_uri: config.linearRedirectUri,
    response_type: "code",
    scope: "read,write,comments:create,app:assignable,app:mentionable",
    actor: "app",
  });
  return reply.redirect(`https://linear.app/oauth/authorize?${params}`);
});

app.get("/oauth/callback", async (request, reply) => {
  const { code, error } = request.query as { code?: string; error?: string };
  if (error) {
    console.error(`[oauth:error] Installation denied: ${error}`);
    return reply.status(400).send({ ok: false, error });
  }
  if (!code) {
    return reply.status(400).send({ ok: false, error: "Missing code" });
  }

  try {
    await exchangeCode(code);
    console.log("[oauth:callback] App installed successfully");
    return reply.send({
      ok: true,
      message: "Linear app installed. You can close this page.",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[oauth:error] Code exchange failed: ${msg}`);
    return reply.status(500).send({ ok: false, error: msg });
  }
});

// --- Recover orphaned sessions from before restart ---
await sessionManager.recoverOrphanedSessions();
await sessionManager.sweepOrphanedInstances();
sessionManager.startPeriodicSweep();

// --- Start ---
app.listen({ port: config.port, host: "0.0.0.0" }, (err) => {
  if (err) {
    console.error("[orchestrator:start] Failed to start public server:", err);
    process.exit(1);
  }
  console.log(`[orchestrator:start] Public server listening on port ${config.port}`);
});

internalApp.listen({ port: config.internalPort, host: "0.0.0.0" }, (err) => {
  if (err) {
    console.error("[orchestrator:start] Failed to start internal server:", err);
    process.exit(1);
  }
  console.log(
    `[orchestrator:start] Internal server listening on port ${config.internalPort}`,
  );
});

// --- Periodic snapshot cleanup (every 6 hours) ---
const SNAPSHOT_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
cleanupExpiredSnapshots().catch((err) => {
  console.error("[orchestrator] Initial snapshot cleanup error:", err);
});
setInterval(() => {
  cleanupExpiredSnapshots().catch((err) => {
    console.error("[orchestrator] Snapshot cleanup error:", err);
  });
}, SNAPSHOT_CLEANUP_INTERVAL_MS).unref();

// --- Graceful shutdown ---
async function shutdown(signal: string) {
  console.log(`[orchestrator:start] ${signal} received, shutting down...`);
  await Promise.all([app.close(), internalApp.close()]);
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
