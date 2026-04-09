# Self-Hosting Guide

End-to-end instructions for deploying the agent infrastructure in your own AWS account.

> **Tip:** If you have [Claude Code](https://claude.ai/code) installed, run `/setup` in this repo for an interactive guided walkthrough. Claude will help you configure repos.json, create AWS resources, set up integrations, and deploy — step by step.

## Prerequisites

- **AWS account** with permissions to create EC2, S3, IAM, Secrets Manager resources
- **Domain name** with DNS managed by Cloudflare (for webhook tunnel)
- **Linear workspace** with admin access (to create OAuth app and webhook)
- **GitHub organization** with the repositories the agent will work on
- **Claude Code OAuth token** (from [claude.ai/code](https://claude.ai/code)) or **Anthropic API key**
- **Node.js 24+** and **pnpm** installed locally (for building)

## Step 1: Fork and Clone

```bash
git clone https://github.com/your-org/hermes-swe.git
cd hermes-swe
pnpm install
pnpm build
```

## Step 2: Configure Repositories

Edit `repos.json` to define which repositories the agent can work on. See the [Repository Configuration](repos-json.md) guide for full details.

**Minimal example** — a single repo using the shared default AMI:

```json
{
  "your-org/your-app": {
    "amiName": "default",
    "workspaceDir": "/workspace/your-app",
    "bakeAmi": false,
    "secrets": [],
    "instanceType": "m6i.xlarge"
  }
}
```

## Step 3: Create AWS Resources

Run the automated setup script:

```bash
bash scripts/aws-setup.sh [region]
# Defaults to eu-north-1
```

This creates:

| Resource | Name | Purpose |
|---|---|---|
| Security Group | `hermes-orchestrator-sg` | Orchestrator EC2 (SSH inbound, agent callback inbound) |
| Security Group | `hermes-agent-sg` | Agent EC2 (SSH + port 3000 from orchestrator only) |
| Security Group | `hermes-bake-sg` | Temporary SG for AMI baking (SSH open) |
| S3 Bucket | `hermes-sessions-{your-account}` | Session state and artifacts |
| Secrets Manager | `hermes/secrets` | All credentials (empty initially) |
| IAM Role | `hermes-orchestrator` | EC2 permissions (S3, Secrets Manager, EC2 lifecycle) |
| SSH Key Pair | `hermes-key` | SSH access to all instances |

The script outputs copy-pasteable commands for the next steps.

## Step 4: Set Up Integrations

Set up each integration by following its dedicated guide:

1. **[Linear Integration](linear.md)** (required) — OAuth app, webhook, secrets
2. **[GitHub Authentication](github.md)** (required) — GitHub App or PAT
3. **[Cloudflare Setup](cloudflare.md)** (required) — Tunnel for webhook ingress
4. **[Slack Notifications](slack.md)** (optional) — Bot for session DMs

## Step 5: Store Secrets

After setting up integrations, store all credentials in AWS Secrets Manager. The secret is a single JSON object stored under the name configured by `aws-setup.sh` (default: `hermes/secrets`).

```bash
aws secretsmanager put-secret-value \
  --secret-id hermes/secrets \
  --secret-string '{
    "LINEAR_WEBHOOK_SECRET": "your-webhook-secret",
    "LINEAR_CLIENT_ID": "your-client-id",
    "LINEAR_CLIENT_SECRET": "your-client-secret",
    "CLAUDE_CODE_OAUTH_TOKEN": "your-claude-token",

    "GITHUB_APP_CLIENT_ID": "your-app-id",
    "GITHUB_APP_PRIVATE_KEY": "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----",
    "GITHUB_APP_INSTALLATION_ID": "12345678",

    "SLACK_BOT_TOKEN": "xoxb-your-bot-token",

    "CLOUDFLARE_API_TOKEN": "your-api-token",
    "CLOUDFLARE_ACCOUNT_ID": "your-account-id",
    "CLOUDFLARE_ZONE_ID": "your-zone-id",

    "SENTRY_ACCESS_TOKEN": "optional-sentry-token",
    "METABASE_API_KEY": "optional-metabase-key"
  }'
```

**Required secrets:**

| Key | Source | Purpose |
|---|---|---|
| `LINEAR_WEBHOOK_SECRET` | [Linear setup](linear.md) | Verify webhook signatures |
| `LINEAR_CLIENT_ID` | [Linear setup](linear.md) | OAuth app |
| `LINEAR_CLIENT_SECRET` | [Linear setup](linear.md) | OAuth app |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code CLI | Agent authentication (or use `ANTHROPIC_API_KEY`) |
| `ANTHROPIC_API_KEY` | Anthropic API | Agent authentication (alternative to OAuth token) |

**Choose one GitHub auth method:**

| Key | Source | Purpose |
|---|---|---|
| `GITHUB_APP_CLIENT_ID` | [GitHub setup](github.md) | GitHub App (recommended) |
| `GITHUB_APP_PRIVATE_KEY` | [GitHub setup](github.md) | GitHub App (recommended) |
| `GITHUB_APP_INSTALLATION_ID` | [GitHub setup](github.md) | GitHub App (recommended) |
| — or — | | |
| `GITHUB_TOKEN` | [GitHub setup](github.md) | Personal Access Token |

**Optional secrets:**

| Key | Source | Purpose |
|---|---|---|
| `SLACK_BOT_TOKEN` | [Slack setup](slack.md) | Session notifications |
| `CLOUDFLARE_API_TOKEN` | [Cloudflare setup](cloudflare.md) | Preview tunnel creation |
| `CLOUDFLARE_ACCOUNT_ID` | [Cloudflare setup](cloudflare.md) | Preview tunnel creation |
| `CLOUDFLARE_ZONE_ID` | [Cloudflare setup](cloudflare.md) | Preview tunnel creation |
| `SENTRY_ACCESS_TOKEN` | Sentry dashboard | Sentry MCP server |
| `METABASE_API_KEY` | Metabase admin | Metabase MCP server |

## Step 6: Launch Orchestrator EC2

Launch a small EC2 instance for the orchestrator:

```bash
aws ec2 run-instances \
  --image-id <ubuntu-24.04-arm64-ami> \
  --instance-type t4g.nano \
  --key-name hermes-key \
  --security-group-ids <hermes-orchestrator-sg-id> \
  --subnet-id <your-subnet-id> \
  --associate-public-ip-address \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=hermes-orchestrator},{Key=Project,Value=hermes}]' \
  --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":20,"VolumeType":"gp3"}}]'
```

> The `aws-setup.sh` script outputs this command with the correct AMI and resource IDs for your region.

Get the public IP:

```bash
aws ec2 describe-instances --filters "Name=tag:Name,Values=hermes-orchestrator" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text
```

## Step 7: Set Up Cloudflare Tunnel on Orchestrator

Before running the setup script, copy your Cloudflare Tunnel credentials to the orchestrator. See [Cloudflare Setup](cloudflare.md) for detailed instructions.

```bash
# Copy tunnel credentials
scp -i ~/.ssh/hermes-key.pem ~/.cloudflared/<tunnel-id>.json \
  ubuntu@<orchestrator-ip>:/tmp/cloudflared-credentials.json
```

## Step 8: Run Setup Script

```bash
ssh -i ~/.ssh/hermes-key.pem ubuntu@<orchestrator-ip> \
  "GITHUB_TOKEN=ghp_xxx bash -s" < scripts/setup-orchestrator.sh
```

This script:
- Installs Node.js 24, pnpm, AWS CLI, cloudflared
- Clones this repo to `/opt/agent/hermes-swe`
- Builds the orchestrator
- Auto-detects VPC networking (private IP, subnet, security groups)
- Writes `/opt/agent/env` with all configuration
- Configures Cloudflare Tunnel as a systemd service
- Configures the orchestrator as a systemd service

## Step 9: Review Orchestrator Configuration

SSH into the orchestrator and verify `/opt/agent/env`:

```bash
ssh -i ~/.ssh/hermes-key.pem ubuntu@<orchestrator-ip>
cat /opt/agent/env
```

Key environment variables:

```bash
# Auto-detected by setup script
CALLBACK_BASE_URL=http://<private-ip>:3002
AWS_REGION=eu-north-1
SUBNET_ID=subnet-xxx
AGENT_SECURITY_GROUP_ID=sg-xxx
KEY_NAME=hermes-key
SESSIONS_BUCKET=hermes-sessions-xxx
SECRET_NAME=hermes/secrets

# Set manually
LINEAR_REDIRECT_URI=https://your-domain.example.com/oauth/callback
PREVIEW_DOMAIN=your-domain.example.com  # Optional, for preview URLs
SLACK_CHANNEL_ID=C0123456789            # Optional, fallback Slack channel
DRY_RUN=false

# AMI IDs (set after baking in Step 10)
AGENT_AMI_ID_DEFAULT=ami-xxx
AGENT_AMI_ID_APP=ami-xxx
```

## Step 10: Bake Agent AMI

From the orchestrator, bake the agent AMI:

```bash
# Generic AMI (for repos with bakeAmi: false)
sudo -u ubuntu bash /opt/agent/hermes-swe/scripts/bake-ami.sh

# Repo-specific AMI (for repos with bakeAmi: true)
sudo -u ubuntu bash /opt/agent/hermes-swe/scripts/bake-ami.sh --repo your-org/your-app
```

This launches a temporary EC2, installs all dependencies (Docker, Node.js, pnpm, Claude Code), clones repos, runs builds, creates an AMI, and updates `/opt/agent/env` with the new AMI ID.

The process takes 10-20 minutes depending on your repo's build time.

## Step 11: Start Orchestrator

```bash
sudo systemctl start orchestrator
sudo systemctl status orchestrator

# Check health
curl -s http://localhost:3001/health | jq
```

## Step 12: Install Linear App

Visit the OAuth install endpoint in your browser:

```
https://your-domain.example.com/oauth/install
```

This redirects to Linear's authorization page. Approve access for your workspace.

## Step 13: Verify End-to-End

1. In Linear, assign a ticket to the agent (the agent appears as an assignable member after OAuth install)
2. Watch the orchestrator logs: `sudo journalctl -u orchestrator -f`
3. The orchestrator should launch an EC2 instance, wait for it to boot, and send the ticket to the agent
4. Progress should appear as activity on the Linear ticket
5. On completion, a PR should be created and the EC2 terminated

---

## Updating

### Deploy Code Changes

```bash
# From your local machine
bash scripts/deploy-orchestrator.sh ubuntu@<orchestrator-ip>

# Or from a non-main branch
bash scripts/deploy-orchestrator.sh ubuntu@<orchestrator-ip> my-branch
```

### Re-bake Agent AMI

Re-bake when dependencies change (new packages, Docker images, etc.):

```bash
# SSH into orchestrator
bash /opt/agent/hermes-swe/scripts/bake-ami.sh --repo your-org/your-app

# Restart orchestrator to use the new AMI
sudo systemctl restart orchestrator
```

---

## Customization

### Adding More Repositories

See [Repository Configuration](repos-json.md) for how to add repos, configure AMIs, set up previews, and add repo-specific scripts.

### Adding Workflow Skills

Skills live in `skills/` and are copied to every agent at boot (by `init-instance.sh`). No AMI re-bake needed — just deploy the code change to the orchestrator and new agents will pick up the updated skills.

1. Create `skills/your-skill/SKILL.md`
2. Follow the format: YAML frontmatter (`name`, `description`) + markdown body with instructions
3. Reference it from the system prompt in `agent-service/prompts/system.md`
4. Deploy: `bash scripts/deploy-orchestrator.sh ubuntu@<orchestrator-ip>`

### Extending the Firewall

The agent firewall blocks all outbound traffic except approved domains. Firewall rules are applied at boot time (by `init-instance.sh`), not baked into the AMI — so changes take effect on the next agent session without re-baking.

- **Base domains**: `ami/allowed-domains.txt` (shared across all repos)
- **Repo-specific domains**: `ami/<scriptsDir>/allowed-domains.txt` (appended at boot)

Add domains one per line (comments with `#`). Deploy the code change to the orchestrator.

### Adding MCP Servers

1. Add the MCP server configuration to your repo's `.mcp.json` at the repository root
2. If the server needs **secrets** (API tokens, credentials): add the key names to the `secrets` array in `repos.json` and the actual values to AWS Secrets Manager. These are written to `/opt/agent/env` and available as environment variables to MCP servers.
3. If the server needs **non-secret config** (URLs, project IDs): create a `.claude/.env.example` in your repo with the values, set `envExample` in `repos.json`, and it gets copied to `.env.local` at boot.

See [Repository Configuration — MCP Server Configuration](repos-json.md#mcp-server-configuration) for details.
