import { config } from "./config.js";

interface UserDataParams {
  /** GitHub App installation token (generated per-session) */
  githubToken: string;
  /** ISO timestamp when the GitHub token expires */
  githubTokenExpiresAt: string;
  /** Live OAuth token from the orchestrator's token manager */
  linearOAuthToken: string;
  orchestratorUrl: string;
  branch: string;
  /** The agent session ID — agent-service uses this to call back /agent-ready */
  agentSessionId: string;
  /** Pre-signed S3 URL for Claude projects artifacts (resume only) */
  artifactsUrl?: string;
  /** Port for agent-service */
  agentServicePort: number;
  /** org/repo identifier (e.g. "org/repo") */
  repo: string;
  /** AMI name from repos.json (e.g. "app") — used to locate repo-specific scripts */
  amiName: string;
  /** Workspace directory from repos.json (e.g. "/workspace/app") */
  workspaceDir: string;
  /** Repo-specific secrets resolved from repos.json config */
  repoSecrets: Record<string, string>;
}

export function generateUserData(params: UserDataParams): string {
  const {
    githubToken,
    githubTokenExpiresAt,
    linearOAuthToken,
    orchestratorUrl,
    branch,
    agentSessionId,
    artifactsUrl,
    agentServicePort,
    repo,
    amiName,
    workspaceDir,
    repoSecrets,
  } = params;

  // GITHUB_TOKEN is passed as an env var to init-instance.sh (never written to disk).
  // GITHUB_TOKEN_EXPIRES_AT is persisted so agent-service can schedule its own refresh.
  const envLines = [
    `GITHUB_TOKEN_EXPIRES_AT=${githubTokenExpiresAt}`,
    `CLAUDE_CODE_OAUTH_TOKEN=${config.secrets.CLAUDE_CODE_OAUTH_TOKEN ?? ""}`,
    `ANTHROPIC_API_KEY=${config.secrets.ANTHROPIC_API_KEY ?? ""}`,
    `LINEAR_OAUTH_ACCESS_TOKEN=${linearOAuthToken}`,
    `ORCHESTRATOR_URL=${orchestratorUrl}`,
    `AGENT_SESSION_ID=${agentSessionId}`,
    `PORT=${agentServicePort}`,
    `REPO=${repo}`,
    `AMI_NAME=${amiName}`,
    `WORKSPACE_DIR=${workspaceDir}`,
    ...(config.previewDomain ? [`PREVIEW_DOMAIN=${config.previewDomain}`] : []),
    ...(config.secrets.CLOUDFLARE_API_TOKEN
      ? [`CLOUDFLARE_API_TOKEN=${config.secrets.CLOUDFLARE_API_TOKEN}`]
      : []),
    ...(config.secrets.CLOUDFLARE_ACCOUNT_ID
      ? [`CLOUDFLARE_ACCOUNT_ID=${config.secrets.CLOUDFLARE_ACCOUNT_ID}`]
      : []),
    ...(config.secrets.CLOUDFLARE_ZONE_ID
      ? [`CLOUDFLARE_ZONE_ID=${config.secrets.CLOUDFLARE_ZONE_ID}`]
      : []),
    ...Object.entries(repoSecrets).map(([k, v]) => `${k}=${v}`),
  ].join("\n");

  // If resuming, download and extract Claude projects artifacts
  const artifactsBlock = artifactsUrl
    ? `
# Restore Claude projects artifacts from previous session
echo "Downloading Claude projects artifacts..."
mkdir -p /home/ubuntu/.claude
curl -sf "${artifactsUrl}" -o /tmp/claude-projects.tar.gz && \\
  tar -xzf /tmp/claude-projects.tar.gz -C /home/ubuntu/.claude && \\
  rm -f /tmp/claude-projects.tar.gz && \\
  echo "Claude projects artifacts restored." || \\
  echo "WARNING: Failed to restore Claude projects artifacts — starting fresh."
`
    : "";

  const agentInfraBranch = config.agentInfraBranch;
  const checkoutBlock = agentInfraBranch
    ? `
# Checkout ai-agent-infra branch: ${agentInfraBranch}
sudo -u ubuntu git -C /opt/agent/hermes-swe -c credential.helper='!f() { echo "username=x-access-token"; echo "password=${githubToken}"; }; f' fetch origin '${agentInfraBranch}'
sudo -u ubuntu git -C /opt/agent/hermes-swe checkout '${agentInfraBranch}'
`
    : "";

  const script = `#!/bin/bash
cat > /opt/agent/env <<'ENVEOF'
${envLines}
ENVEOF
chmod 600 /opt/agent/env
${artifactsBlock}${checkoutBlock}
# Pull latest init script before running
sudo -u ubuntu git -C /opt/agent/hermes-swe -c credential.helper='!f() { echo "username=x-access-token"; echo "password=${githubToken}"; }; f' pull --ff-only
GITHUB_TOKEN=${githubToken} bash /opt/agent/hermes-swe/ami/init-instance.sh '${branch}' ${agentServicePort}
`;

  return Buffer.from(script).toString("base64");
}
