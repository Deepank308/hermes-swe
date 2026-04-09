# CLAUDE.md

AI Agent Infrastructure — Remote Claude Code dev environments triggered by Linear tickets.

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

```
hermes-swe/
├── ami/                  # EC2 provisioning & firewall scripts
│   ├── setup.sh          # Base AMI deps: Docker, Node 24, pnpm, yarn, gh, Claude Code
│   ├── prepare-ami.sh    # Pre-bake AMI: clone repos, delegate to repo scripts
│   ├── init-instance.sh  # Boot-time init: pull code, delegate to repo scripts
│   ├── firewall.sh       # Outbound allowlist (ipset/iptables)
│   ├── allowed-domains.txt  # Base firewall domains (shared across all repos)
│   ├── preview-launch.sh # Generic: reads launch.json, runs preview, creates Cloudflare tunnel
│   ├── <name>/           # Repo-specific scripts (scriptsDir: "ami/<name>")
│   │   ├── setup.sh      # Yarn 1.22.22, Turbo, kernel tuning, Docker pulls
│   │   ├── prepare.sh    # Build app, pre-commit, Docker compose build
│   │   ├── pre-agent.sh  # Start db16 early (MCP servers need DB)
│   │   ├── post-agent.sh # Docker services, yarn build
│   │   ├── launch.json   # Preview configurations (copied to workspace/.claude/)
│   │   ├── preview/      # Preview scripts (copied to workspace/.claude/preview/)
│   │   └── allowed-domains.txt  # App-specific firewall domains
│   └── hermes-swe/       # hermes-swe scripts (scriptsDir: "ami/hermes-swe")
│       └── post-agent.sh # Auto-detect package manager, install deps
├── agent-service/        # Runs ON agent EC2 — manages Claude sessions
│   ├── src/index.ts      # HTTP server (/run, /message, /stop, /health)
│   ├── src/session.ts    # Claude session lifecycle
│   └── prompts/system.md # System prompt — routes tickets to workflow skills
├── orchestrator/         # Runs ON orchestrator EC2 — webhook + EC2 lifecycle
│   ├── src/index.ts      # Fastify server, webhook routes, OAuth
│   ├── src/webhook-handler.ts  # Linear webhook → provision → run → teardown
│   ├── src/ec2.ts        # Launch/terminate EC2 instances
│   ├── src/session-store.ts    # S3-backed session state (cached in memory)
│   └── src/slack.ts      # Threaded Slack notifications
├── skills/               # Workflow skills — copied to ~/.claude/skills/ at boot
│   ├── full-development/ # Features, enhancements, refactors (plan → TDD → PR)
│   ├── debugging/        # Bug reports, Sentry issues (investigate → fix → PR)
│   └── simple-question/  # Questions, clarifications (research → answer)
├── scripts/
│   ├── aws-setup.sh      # Create AWS resources (SGs, S3, Secrets Manager)
│   ├── bake-ami.sh       # Automated AMI baking (--repo flag, run from orchestrator)
│   ├── setup-orchestrator.sh   # Fresh orchestrator EC2 setup
│   └── deploy-orchestrator.sh  # Deploy updates to orchestrator
├── repos.json            # Repo configs (amiName, scriptsDir, workspaceDir, secrets, instanceType)
└── package.json          # Root (pnpm workspace)
```

## Flow

1. Linear ticket assigned to agent → webhook fires
2. Orchestrator receives webhook via Cloudflare Tunnel
3. Orchestrator launches agent EC2 from pre-baked AMI
4. Agent EC2 boots: pulls code, starts Docker stack, starts agent-service
5. Orchestrator sends `/run` to agent-service with prompt
6. Claude works on the ticket (reads code, runs tests, creates PR)
7. Agent-service reports progress to Linear (thoughts, actions, completion)
8. On completion, agent-service calls orchestrator `/callback`
9. Orchestrator terminates EC2, notifies Slack, processes queue

## Network & Security

### Security Groups

| Security Group             | Inbound Rules                  | Access Method                            |
| -------------------------- | ------------------------------ | ---------------------------------------- |
| `hermes-orchestrator-sg`   | Port 3002 from agent SG        | SSH: key pair                            |
|                            |                                | Webhooks: Cloudflare Tunnel (bypasses SG)|
| `hermes-agent-sg` (agents) | Port 22 from orchestrator SG   | SSH: hop through orchestrator            |
|                            | Port 3000 from orchestrator SG | API: orchestrator only                   |

### Traffic Paths

| Path                     | Route                                      | Auth                                        |
| ------------------------ | ------------------------------------------ | ------------------------------------------- |
| Linear → Orchestrator    | Cloudflare Tunnel (HTTPS)                  | Webhook signature (`LINEAR_WEBHOOK_SECRET`) |
| Orchestrator → Agent EC2 | VPC private IP :3000                       | Same SG (no additional auth)                |
| Agent EC2 → Orchestrator | VPC private IP :3002                       | Same SG (no additional auth)                |
| Agent EC2 → Internet     | Outbound allowlist (`firewall.sh`)         | Per-service tokens                          |
| You → Orchestrator       | `ssh -i ~/.ssh/hermes-key.pem ubuntu@<ip>` | SSH key pair                                |
| You → Agent EC2          | Orchestrator → `ssh ubuntu@<private-ip>`   | SSH key pair                                |

### Outbound Allowlist (agent EC2)

Managed by `ami/firewall.sh` — only these domains are reachable:

- Anthropic: `api.anthropic.com`, `claude.ai`
- GitHub: `api.github.com`, `github.com`
- Linear: `api.linear.app`
- Package registries: `npmjs.org`, `pypi.org`, Docker Hub
- Cloudflare: `api.cloudflare.com` (named tunnel creation, repo-specific)
- AWS: S3, Secrets Manager endpoints
- Repo-specific: `ami/<name>/allowed-domains.txt` appended at boot

## Development Commands

```bash
pnpm install              # Install all workspace dependencies
pnpm build                # Build all packages
pnpm -r lint              # Lint all packages
```

## Deployment

### Orchestrator (one-time)

```bash
# 1. Setup AWS resources
bash scripts/aws-setup.sh eu-north-1

# 2. Launch t4g.nano EC2 with hermes-orchestrator-sg

# 3. Run setup script
ssh ubuntu@<ip> "GITHUB_TOKEN=ghp_xxx bash -s" < scripts/setup-orchestrator.sh

# 4. Create /opt/agent/env, start service
```

### Deploy updates

```bash
bash scripts/deploy-orchestrator.sh ubuntu@<ip>
```

### Agent AMI (when dependencies change)

```bash
# From the orchestrator — fully automated:
bash scripts/bake-ami.sh --repo your-org/your-app
# Launches EC2, runs setup + repo-specific setup + prepare-ami, creates AMI,
# terminates instance, updates AMI_ID in /opt/agent/env.
# Restart orchestrator to pick up new AMI.

# Generic AMI (no pre-baked repo — clone happens at boot):
bash scripts/bake-ami.sh
```

## Key Dependencies

- **@linear/sdk** for Linear API calls (webhook verification via `LinearWebhookClient`, activity reporting, comments)
- **agent-service** uses `cyrus-claude-runner` to manage Claude sessions
- **agent-service** depends on `cyrus-core` for shared types (`AskUserQuestionInput`/`AskUserQuestionResult`)
- **@aws-sdk** for EC2, S3, Secrets Manager

## Data Storage

### AWS Secrets Manager (`hermes/secrets`)

Centralized secrets fetched once at orchestrator startup and cached in memory.

| Key                            | Purpose                                         | Used by                                      |
| ------------------------------ | ----------------------------------------------- | -------------------------------------------- |
| `GITHUB_APP_CLIENT_ID`         | GitHub App ID                                   | Orchestrator (App auth)                      |
| `GITHUB_APP_PRIVATE_KEY`       | GitHub App private key (PEM)                    | Orchestrator (App auth)                      |
| `GITHUB_APP_INSTALLATION_ID`   | GitHub App installation ID                      | Orchestrator (App auth)                      |
| `GITHUB_TOKEN`                 | Static GitHub PAT (alternative to App auth)     | Orchestrator → passed to agent via user-data |
| `LINEAR_WEBHOOK_SECRET`        | Verify Linear webhook signatures                | Orchestrator                                 |
| `LINEAR_CLIENT_ID`             | Linear OAuth app (code exchange, token refresh) | Orchestrator                                 |
| `LINEAR_CLIENT_SECRET`         | Linear OAuth app (code exchange, token refresh) | Orchestrator                                 |
| `SLACK_BOT_TOKEN`              | Post threaded messages to Slack                 | Orchestrator                                 |
| `CLAUDE_CODE_OAUTH_TOKEN`      | Claude Code CLI authentication                  | Orchestrator → passed to agent via user-data |
| `ANTHROPIC_API_KEY`            | Anthropic API key (alternative to OAuth token)  | Orchestrator → passed to agent via user-data |
| `SENTRY_ACCESS_TOKEN`          | Sentry MCP server authentication                | Orchestrator → agent → `.claude/.env.local`  |
| `METABASE_API_KEY`             | Metabase MCP server authentication              | Orchestrator → agent → `.claude/.env.local`  |
| `CLOUDFLARE_API_TOKEN`         | Cloudflare API (Zone:DNS:Edit + Tunnel:Edit)    | Orchestrator → agent (tunnel creation)       |
| `CLOUDFLARE_ACCOUNT_ID`        | Cloudflare account ID                           | Orchestrator → agent (tunnel creation)       |
| `CLOUDFLARE_ZONE_ID`           | Cloudflare zone ID for preview domain           | Orchestrator → agent (tunnel creation)       |

**GitHub auth**: Configure either GitHub App credentials (`GITHUB_APP_CLIENT_ID` + `GITHUB_APP_PRIVATE_KEY` + `GITHUB_APP_INSTALLATION_ID`) or a static `GITHUB_TOKEN` PAT. App auth generates short-lived installation tokens with automatic refresh; PAT auth uses the token as-is with no refresh.

### S3 (`hermes-sessions`)

| Key                                                | Format                                         | Purpose                                                                                        |
| -------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `sessions.json`                                    | JSON `{ sessions: Record<id, SessionRecord> }` | All session state — status, instance IDs, IPs, branch, Slack thread ts                         |
| `sessions/{agentSessionId}/claude-projects.tar.gz` | gzip tarball                                   | Claude projects artifacts (CLAUDE.md, todo, etc.) — uploaded on completion, restored on resume |

### Orchestrator Disk (`/opt/agent/hermes-swe/orchestrator/`)

| Path                                    | Format                                          | Purpose                                                            |
| --------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------ |
| `.logs/webhooks/{agentSessionId}.jsonl` | JSONL (one entry per webhook)                   | Raw webhook event log per session — debugging                      |
| `.linear-tokens.json`                   | JSON `Record<orgId, { accessToken, refreshToken, expiresAt, organizationName }>` | Per-org Linear OAuth tokens — persisted across restarts, auto-refreshed |
| `sessions-local.json`                   | JSON (mirror of S3 sessions.json)               | Local backup of session state — written alongside every S3 persist |

### Agent EC2 Disk

| Path                                | Format                                                                 | Purpose                                                                                                                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/opt/agent/env`                    | Shell env file                                                         | Runtime secrets written by orchestrator user-data (GITHUB_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, LINEAR_OAUTH_ACCESS_TOKEN, ORCHESTRATOR_URL, SENTRY_ACCESS_TOKEN, METABASE_API_KEY, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ZONE_ID, PREVIEW_DOMAIN) |
| `/workspace/app/.claude/.env.local` | dotenv file                                                            | MCP server env vars — populated from `/opt/agent/env` using `.env.example` as template                                                                                        |
| `/home/ubuntu/.cyrus/sessions.json` | JSON `Record<agentSessionId, { claudeSessionId, issueId, startedAt }>` | Maps Linear agent sessions to Claude CLI session IDs — needed for resume                                                                                                      |
| `/home/ubuntu/.cyrus/`              | Various                                                                | Claude runner logs and internal state                                                                                                                                         |
| `/home/ubuntu/.claude/skills/`      | SKILL.md files                                                         | Workflow skills copied from hermes-swe/skills/ by init-instance.sh                                                                                                        |
| `/home/ubuntu/.claude/projects/`    | Various                                                                | Claude Code project memory — tarred and uploaded to S3 on completion                                                                                                          |
| `/workspace/app/`                   | Git repo                                                               | The application codebase Claude works on                                                                                                                                      |
| `/opt/agent/hermes-swe/`        | Git repo                                                               | This repo — pulled fresh on boot                                                                                                                                              |
| `/opt/agent/ready`                  | Empty marker file                                                      | Signals instance init completed                                                                                                                                               |

### Orchestrator Environment (`/opt/agent/env`)

Non-secret configuration loaded at process start:

| Variable                  | Purpose                                       |
| ------------------------- | --------------------------------------------- |
| `AMI_ID`                  | Pre-baked AMI for agent EC2 instances         |
| `AGENT_SUBNET_ID`         | VPC subnet for launching agent EC2 instances  |
| `AGENT_SECURITY_GROUP_ID` | Security group for agent EC2 instances        |
| `SESSIONS_BUCKET`         | S3 bucket name                                |
| `SECRET_NAME`             | Secrets Manager secret name                   |
| `AWS_REGION`              | AWS region                                    |
| `CALLBACK_BASE_URL`       | Orchestrator's VPC private IP (auto-detected) |
| `LINEAR_REDIRECT_URI`     | OAuth callback URL (Cloudflare Tunnel)        |
| `KEY_NAME`                | SSH key pair name (optional)                  |
| `SLACK_CHANNEL_ID`        | Slack channel for notifications (optional)    |
| `IAM_INSTANCE_PROFILE`    | IAM role for agent EC2 (optional)             |
| `SNAPSHOT_RETENTION_DAYS` | How long to keep EBS snapshots (default: 15)  |

### In-Memory Only (not persisted)

| Component     | Data                                  | Notes                                                             |
| ------------- | ------------------------------------- | ----------------------------------------------------------------- |
| Orchestrator  | Secrets cache                         | Loaded once from Secrets Manager, never written back              |
| Orchestrator  | Session store cache                   | Loaded once from S3, mutated in-memory, persisted on every change |
| Orchestrator  | Linear OAuth token cache              | Per-org Map, also persisted to `.linear-tokens.json`              |
| Orchestrator  | LinearClient instances                | Per-org Map, created lazily on first webhook per org              |
| Agent-service | SessionManager state                  | Current session state, runner instance, pending thoughts          |
| Agent-service | LinearReporter dead sessions set      | Tracks sessions that returned "Entity not found" to avoid retries |

## Environment

- Orchestrator: EC2 t4g.nano, Cloudflare Tunnel for HTTPS
- Agent: EC2 m6i.xlarge (16GB RAM, Ubuntu 22.04)
- Agent runs: Docker (PostgreSQL, Redis, OpenSearch, app), Node.js 24, Claude Code
- Config: `/opt/agent/env` on both orchestrator and agent EC2
- Session state: S3 (`sessions.json`), cached in memory
- Secrets: AWS Secrets Manager (`hermes/secrets`)
