export interface PreviewEntry {
  url: string;
  label: string;
}

export type SessionStatus =
  | "queued"
  | "provisioning"
  | "running"
  | "completed"
  | "failed"
  | "stopped";

export interface SessionRecord {
  agentSessionId: string;
  /** org/repo identifier (e.g. "org/repo") */
  repo: string;
  url: string;
  agentSessionUrl?: string;
  instanceId?: string;
  privateIp?: string;
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
  teamId: string;
  branch: string;
  status: SessionStatus;
  /** Linear organization ID — routes to the correct OAuth token */
  organizationId: string;
  /** Claude CLI session ID — needed to resume conversations */
  claudeSessionId?: string;
  /** The prompt to send to the agent — stored at provision time, sent when /agent-ready arrives */
  prompt?: string;
  /** For session resume: the previous agent session ID */
  resumeAgentSessionId?: string;
  /** Plan steps from previous session — passed to agent on resume for continuity */
  plan?: Array<{ content: string; status: string }>;
  createdAt: string;
  updatedAt: string;
  summary?: string;
  /** Slack thread ts — first message creates thread, subsequent messages reply */
  slackThreadTs?: string;
  /** Email of the person who triggered the session (from Linear webhook creator field) */
  creatorEmail?: string;
  /** Slack DM channel ID for the session creator */
  slackDmChannelId?: string;
  /** Slack user ID for the session creator (for @mentions) */
  slackUserId?: string;
  /** Pull request URL created by the agent */
  prUrl?: string;
  /** Preview URLs for dev UI (named Cloudflare tunnels — one per launch.json config) */
  previewUrls?: PreviewEntry[];
  /** EBS snapshot ID created when the instance was terminated */
  snapshotId?: string;
}

export interface CompletionCallback {
  agentSessionId: string;
  status: "completed" | "failed" | "stopped";
  summary?: string;
  prUrl?: string;
  previewUrls?: PreviewEntry[];
}

/** Secrets stored in AWS Secrets Manager */
export interface StoredSecrets {
  /** GitHub App credentials (used when App auth is configured) */
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_INSTALLATION_ID?: string;
  /** Static GitHub PAT (used when App auth is not configured) */
  GITHUB_TOKEN?: string;
  LINEAR_WEBHOOK_SECRET: string;
  LINEAR_CLIENT_ID: string;
  LINEAR_CLIENT_SECRET: string;
  SLACK_BOT_TOKEN?: string;
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  SENTRY_ACCESS_TOKEN?: string;
  METABASE_API_KEY?: string;
  /** Cloudflare API token with Zone:DNS:Edit + Account:Cloudflare Tunnel:Edit */
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_ZONE_ID?: string;
}
