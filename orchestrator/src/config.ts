import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { StoredSecrets } from "./types.js";

const dryRun = process.env.DRY_RUN === "true";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function requiredUnlessDryRun(name: string, mockValue: string): string {
  if (dryRun) return process.env[name] ?? mockValue;
  return required(name);
}

function optional(name: string, defaultValue: string): string;
function optional(name: string): string | undefined;
function optional(name: string, defaultValue?: string): string | undefined {
  return process.env[name] ?? defaultValue;
}

/** Secrets loaded from AWS Secrets Manager (or env vars in dry-run mode) */
const secrets: StoredSecrets = dryRun
  ? {
      LINEAR_WEBHOOK_SECRET: required("LINEAR_WEBHOOK_SECRET"),
      LINEAR_CLIENT_ID: required("LINEAR_CLIENT_ID"),
      LINEAR_CLIENT_SECRET: required("LINEAR_CLIENT_SECRET"),
      CLAUDE_CODE_OAUTH_TOKEN: optional("CLAUDE_CODE_OAUTH_TOKEN", ""),
      ANTHROPIC_API_KEY: optional("ANTHROPIC_API_KEY", ""),
      GITHUB_APP_CLIENT_ID: optional("GITHUB_APP_CLIENT_ID"),
      GITHUB_APP_PRIVATE_KEY: optional("GITHUB_APP_PRIVATE_KEY"),
      GITHUB_APP_INSTALLATION_ID: optional("GITHUB_APP_INSTALLATION_ID"),
      GITHUB_TOKEN: optional("GITHUB_TOKEN"),
      SLACK_BOT_TOKEN: optional("SLACK_BOT_TOKEN"),
      SENTRY_ACCESS_TOKEN: optional("SENTRY_ACCESS_TOKEN"),
      METABASE_API_KEY: optional("METABASE_API_KEY"),
      CLOUDFLARE_API_TOKEN: optional("CLOUDFLARE_API_TOKEN"),
      CLOUDFLARE_ACCOUNT_ID: optional("CLOUDFLARE_ACCOUNT_ID"),
      CLOUDFLARE_ZONE_ID: optional("CLOUDFLARE_ZONE_ID"),
    }
  : ({} as StoredSecrets); // Populated by loadSecrets() before server starts

export const config = {
  dryRun,
  port: Number(optional("PORT", "3001")),
  internalPort: Number(optional("INTERNAL_PORT", "3002")),
  maxConcurrent: Number(optional("MAX_CONCURRENT", "5")),
  callbackBaseUrl: required("CALLBACK_BASE_URL"),
  linearRedirectUri: required("LINEAR_REDIRECT_URI"),
  slackChannelId: optional("SLACK_CHANNEL_ID", ""),
  agentServicePort: Number(optional("AGENT_SERVICE_PORT", "3000")),
  agentAmiId: requiredUnlessDryRun("AGENT_AMI_ID", "ami-dry-run"),
  agentInstanceType: requiredUnlessDryRun(
    "AGENT_INSTANCE_TYPE",
    "instance-type-dry-run",
  ),
  /** Subnet where agent EC2 instances are launched */
  subnetId: requiredUnlessDryRun("SUBNET_ID", "subnet-dry-run"),
  /** Security group for agent EC2 instances (SSH + port 3000 from orchestrator only) */
  agentSecurityGroupId: requiredUnlessDryRun(
    "AGENT_SECURITY_GROUP_ID",
    "sg-dry-run",
  ),
  keyName: optional("KEY_NAME", ""),
  agentIamInstanceProfile: optional("AGENT_IAM_INSTANCE_PROFILE", ""),
  sessionsBucket: requiredUnlessDryRun("SESSIONS_BUCKET", "dry-run-bucket"),
  sessionsKey: requiredUnlessDryRun("SESSIONS_KEY", "sessions-key-dry-run"),
  secretName: requiredUnlessDryRun("SECRET_NAME", "secret-name-dry-run"),
  awsRegion: requiredUnlessDryRun("AWS_REGION", "aws-region-dry-run"),

  instanceStartupTimeoutSeconds: Number(
    optional("INSTANCE_STARTUP_TIMEOUT_SECONDS", "300"),
  ),
  agentReadyTimeoutMs: Number(optional("AGENT_READY_TIMEOUT_MS", "1800000")),
  artifactsUrlExpiry: Number(optional("ARTIFACTS_URL_EXPIRY_SECONDS", "3600")),
  /** Write webhook logs and session store to local disk. Defaults to true in dry-run mode. */
  localLogging:
    process.env.LOCAL_LOGGING !== undefined
      ? process.env.LOCAL_LOGGING === "true"
      : dryRun,

  defaultRepo: optional("DEFAULT_REPO", ""),

  /** How long to keep EBS snapshots in days */
  snapshotRetentionDays: Number(optional("SNAPSHOT_RETENTION_DAYS", "15")),

  /** Branch for ai-agent-infra on agent EC2 (defaults to main) */
  agentInfraBranch: optional("AGENT_INFRA_BRANCH", ""),

  /** Domain for named Cloudflare tunnel preview URLs (e.g. "yourdomain.com") */
  previewDomain: optional("PREVIEW_DOMAIN", ""),

  secrets,
};

/** Load secrets from Secrets Manager into config.secrets. Must be called before server starts. */
export function loadSecrets(fetched: StoredSecrets): void {
  if (config.dryRun) {
    console.log("[config:load] DRY RUN: Secrets loaded from environment variables");
    return;
  }
  Object.assign(config.secrets, fetched);
  console.log("[config:load] Secrets loaded from Secrets Manager");
}

// --- Per-repo configuration ---

export interface RepoConfig {
  amiName: string;
  /** Relative path to repo-specific scripts (e.g. "ami/app"). No fallback — repos without scriptsDir get no custom scripts. */
  scriptsDir?: string;
  workspaceDir: string;
  bakeAmi: boolean;
  secrets: string[];
  envExample?: string;
  instanceType: string;
  /** Loaded from env var AGENT_AMI_ID_${AMI_NAME_UPPER} */
  amiId: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const reposJsonPath = path.join(__dirname, "../../repos.json");

const repoConfigs: Record<string, RepoConfig> = {};
try {
  const reposJson = JSON.parse(fs.readFileSync(reposJsonPath, "utf-8"));
  for (const [key, raw] of Object.entries(reposJson)) {
    const cfg = raw as Record<string, unknown>;
    const envVar = `AGENT_AMI_ID_${(cfg.amiName as string).toUpperCase()}`;
    repoConfigs[key] = {
      amiName: cfg.amiName as string,
      scriptsDir: (cfg.scriptsDir as string) || undefined,
      workspaceDir: cfg.workspaceDir as string,
      bakeAmi: cfg.bakeAmi as boolean,
      secrets: (cfg.secrets as string[]) ?? [],
      envExample: cfg.envExample as string | undefined,
      instanceType: (cfg.instanceType as string) ?? config.agentInstanceType,
      amiId: process.env[envVar] ?? "",
    };
  }
  console.log(
    `[config:load] Loaded repo configs: ${Object.keys(repoConfigs).join(", ")}`,
  );
} catch (err) {
  console.warn(
    `[config:load] Failed to load repos.json: ${err instanceof Error ? err.message : err}`,
  );
}

export function getRepoConfig(repo: string): RepoConfig {
  const cfg = repoConfigs[repo];
  if (!cfg) {
    throw new Error(
      `No configuration found for repo "${repo}" in repos.json. Available: ${Object.keys(repoConfigs).join(", ")}`,
    );
  }
  return cfg;
}

/**
 * Build candidate repositories for Linear's issueRepositorySuggestions API.
 */
export function getCandidateRepos(): Array<{
  hostname: string;
  repositoryFullName: string;
}> {
  return Object.keys(repoConfigs).map((key) => ({
    hostname: "github.com",
    repositoryFullName: key,
  }));
}
