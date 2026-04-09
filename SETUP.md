# hermes-swe

Remote AI agent dev environments triggered by Linear tickets. Claude Code works autonomously on tickets with a full test environment on EC2.

## How It Works

```
Linear ticket assigned to agent
  → Webhook → Orchestrator (via Cloudflare Tunnel)
    → Launch EC2 from pre-baked AMI
    → agent-service starts Claude Code
    → Claude works: reads code, runs tests, creates PR
    → Progress streamed to Linear as agent activities
    → User comments forwarded mid-flight
    → On completion: EC2 terminated, Slack notified
```

## Architecture

```
Linear webhook ──HTTPS──▶ Cloudflare Tunnel ──▶ Orchestrator (t4g.nano)
                                                  │
                                         VPC private IP
                                                  │
                                    ┌─────────────▼─────────────┐
                                    │  Agent EC2 (m6i.xlarge)   │
                                    │  ┌──────────────────────┐ │
                                    │  │ agent-service :3000  │ │
                                    │  │ Claude Code CLI      │ │
                                    │  │ Docker (app stack)   │ │
                                    │  └──────────────────────┘ │
                                    └───────────────────────────┘
```

## Project Structure

| Directory        | Purpose                                                 |
| ---------------- | ------------------------------------------------------- |
| `ami/`           | EC2 provisioning, AMI baking, boot-time init, preview tunnel |
| `ami/<name>/`    | Repo-specific scripts (Docker setup, preview, etc.)         |
| `ami/hermes-swe/` | hermes-swe scripts (auto-detect deps install)  |
| `agent-service/` | Runs on agent EC2 — manages Claude Code sessions        |
| `orchestrator/`  | Runs on orchestrator EC2 — webhook + EC2 lifecycle      |
| `skills/`        | Workflow skills — copied to `~/.claude/skills/` at boot |
| `scripts/`       | AWS setup, orchestrator deploy, AMI baking              |
| `repos.json`     | Repo configs — maps `org/repo` to AMI/instance settings |

## Setup

### Prerequisites

- AWS account with EC2, S3, Secrets Manager access
- [Cloudflare](https://cloudflare.com) account with a domain (tunnel is created automatically during setup)
- Linear OAuth app (CLIENT_ID, CLIENT_SECRET, WEBHOOK_SECRET)
- GitHub personal access token (repo scope). GitHub App also recommended for agent operations.
- Claude Code OAuth token or Anthropic API key
- (Optional) Slack bot token + channel ID

### 1. Configure

```bash
cp .env.example .env.local
```

Edit `.env.local` and fill in the required values. See comments in `.env.example` for details.

### 2. Configure repos.json

Edit `repos.json` to add the repositories the agent will work on. See `repos.example.json` for the format and `docs/repos-json.md` for detailed documentation.

### 3. Run setup

```bash
bash scripts/setup.sh
```

This creates AWS resources, launches the orchestrator EC2, sets up a Cloudflare tunnel (you click one URL to authorize), pushes secrets, and deploys the orchestrator.

### 4. Connect Linear

Visit the URL printed at the end of setup (`https://<your-domain>/oauth/install`).

### 5. Bake an agent AMI (optional)

Only needed for repos with `bakeAmi: true` in `repos.json` (heavy dependencies, Docker services). Repos with `bakeAmi: false` clone and install at boot time — no AMI needed.

```bash
ssh -i ~/.ssh/hermes-key.pem ubuntu@<ORCHESTRATOR_IP>
bash /opt/agent/hermes-swe/scripts/bake-ami.sh --repo your-org/your-app
```

### 6. Verify end-to-end

1. Assign a Linear ticket to the agent
2. Check orchestrator logs: `journalctl -u orchestrator -f`
3. Verify: agent EC2 launches, works on ticket, creates PR

### Deploy updates

```bash
bash scripts/deploy-orchestrator.sh ubuntu@<orchestrator-ip>
```

## Configuration

### Shared constants (`scripts/aws-config.sh`)

All AWS resource names and defaults in one place — sourced by `aws-setup.sh` and `setup-orchestrator.sh`:

| Variable              | Default                         | Purpose                                  |
| --------------------- | ------------------------------- | ---------------------------------------- |
| `AWS_REGION`          | `eu-north-1`                    | AWS region                               |
| `BUCKET_NAME`         | `hermes-sessions` | S3 bucket for session state              |
| `SECRET_NAME`         | `hermes/secrets`                | Secrets Manager secret name              |
| `SESSIONS_KEY`        | `sessions.json`                 | S3 object key for sessions               |
| `ORCH_INSTANCE_TYPE`  | `t4g.nano`                      | Orchestrator EC2 instance type (~$3/mo)  |
| `AGENT_INSTANCE_TYPE` | `m6i.xlarge`                    | Agent EC2 instance type                  |
| `ORCH_PORT`           | `3001`                          | Orchestrator HTTP port                   |
| `ORCH_INTERNAL_PORT`  | `3002`                          | Orchestrator Internal HTTP port          |
| `AGENT_SERVICE_PORT`  | `3000`                          | Agent service HTTP port                  |
| `SNAPSHOT_RETENTION_DAYS` | `15`                        | How long to keep EBS snapshots (days)    |
| `AGENT_BAKE_SG_NAME`  | `hermes-bake-sg`                | Security group for AMI baking (SSH open) |

### Orchestrator env vars (`/opt/agent/env`)

Auto-set by `setup-orchestrator.sh` (from metadata + AWS API):

| Variable                  | Source                           |
| ------------------------- | -------------------------------- |
| `CALLBACK_BASE_URL`       | EC2 private IP                   |
| `LINEAR_REDIRECT_URI`     | Cloudflare Tunnel URL            |
| `AWS_REGION`              | Instance metadata                |
| `SUBNET_ID`               | Instance metadata                |
| `AGENT_SECURITY_GROUP_ID` | AWS API lookup                   |
| `KEY_NAME`                | AWS API lookup                   |
| `AGENT_AMI_ID`            | AWS API lookup (or set manually) |
| `SESSIONS_BUCKET`         | From aws-config.sh               |
| `SECRET_NAME`             | From aws-config.sh               |
| `SESSIONS_KEY`            | From aws-config.sh               |
| `AGENT_INSTANCE_TYPE`     | From aws-config.sh               |
| `SNAPSHOT_RETENTION_DAYS` | From aws-config.sh               |

Set manually if needed:

| Variable                     | Purpose                              |
| ---------------------------- | ------------------------------------ |
| `SLACK_CHANNEL_ID`           | Slack channel for notifications      |
| `AGENT_IAM_INSTANCE_PROFILE` | IAM profile for agent EC2 (optional) |

### Secrets Manager (`hermes/secrets`)

| Key                          | Purpose                                       |
| ---------------------------- | --------------------------------------------- |
| `GITHUB_APP_CLIENT_ID`       | GitHub App ID (for App auth)                  |
| `GITHUB_APP_PRIVATE_KEY`     | GitHub App private key PEM (for App auth)     |
| `GITHUB_APP_INSTALLATION_ID` | GitHub App installation ID (for App auth)     |
| `GITHUB_TOKEN`               | Static GitHub PAT (alternative to App auth)   |
| `LINEAR_WEBHOOK_SECRET`      | Verify Linear webhook signatures              |
| `LINEAR_CLIENT_ID`           | Linear OAuth app client ID                    |
| `LINEAR_CLIENT_SECRET`       | Linear OAuth app client secret                |
| `CLAUDE_CODE_OAUTH_TOKEN`    | Auth token for Claude Code CLI (or use `ANTHROPIC_API_KEY`) |
| `ANTHROPIC_API_KEY`          | Anthropic API key (alternative to OAuth token) |
| `SLACK_BOT_TOKEN`            | Slack Bot API token (optional)                |
| `SENTRY_ACCESS_TOKEN`        | Sentry MCP server authentication (optional)   |
| `METABASE_API_KEY`           | Metabase MCP server authentication (optional) |
| `CLOUDFLARE_API_TOKEN`       | Cloudflare API token (Zone:DNS:Edit + Tunnel:Edit) for preview tunnels |
| `CLOUDFLARE_ACCOUNT_ID`      | Cloudflare account ID for preview tunnels     |
| `CLOUDFLARE_ZONE_ID`         | Cloudflare zone ID for the preview domain     |

**GitHub auth**: Set either `GITHUB_APP_*` fields (recommended — generates short-lived tokens with auto-refresh) or `GITHUB_TOKEN` (static PAT, no refresh). Agent commits are attributed to the GitHub App bot account when using App auth.

## Development

```bash
pnpm install    # Install all workspace dependencies
pnpm build      # Build all packages
pnpm -r lint    # Lint all packages
```

### Local dry-run

Set `DRY_RUN=true` in `orchestrator/.env` to run the orchestrator locally without AWS resources. Requires `LINEAR_WEBHOOK_SECRET`, `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET` set as env vars.

## Security

- **Orchestrator**: SSH open for access. Webhooks via Cloudflare Tunnel (outbound connection, no inbound ports needed). Agent callbacks allowed from agent SG on port 3002.
- **Agent EC2**: Inbound restricted to orchestrator SG only (SSH + port 3000). Outbound restricted by iptables/ipset to allowlist (`ami/allowed-domains.txt`): Anthropic, GitHub, Linear, package registries, AWS, Docker registries.
- **Firewall**: `ami/firewall.sh` applies after services are healthy. `ami/reset-firewall.sh` to disable for debugging. Docker FORWARD traffic is preserved. Repo-specific domains can be added via `ami/<name>/allowed-domains.txt`.
- **Secrets**: Stored in AWS Secrets Manager, fetched at orchestrator startup, passed to agents via EC2 user-data (written to `/opt/agent/env`).
- **Networking**: Orchestrator and agents share the same VPC subnet. Agent callbacks use VPC private IPs (no public internet).

## Key Dependencies

- [@linear/sdk](https://github.com/linear/linear) — Linear API client (webhook verification, activity reporting, comments)
- [cyrus-claude-runner](https://github.com/ceedaragents/cyrus) — Claude session management
- [Claude Code CLI](https://claude.ai/code) — AI coding agent
