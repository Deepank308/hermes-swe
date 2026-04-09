---
name: setup
description: Interactive guided setup for self-hosting this infrastructure. Walks through .env.local configuration, repos.json, running setup.sh, connecting Linear, and optional AMI baking.
---

# Self-Hosting Setup Guide

Help the user set up this infrastructure for their own repositories and AWS account. This is an interactive walkthrough — ask questions, validate inputs, and guide them through each step.

**Important:** Read `SETUP.md` and `.env.example` first for the full setup flow. Use the docs in `docs/` as references for each integration.

## Phase 1: Understand Their Setup

Ask the user about their environment:

1. **Which repositories** will the agent work on? (GitHub org/repo names)
2. **AWS region** preference (default: eu-north-1)
3. **Domain name** they'll use for the orchestrator (e.g. `hermes.example.com`)
4. **Which integrations** they want:
   - Linear (required)
   - GitHub App or PAT only? (recommend App for short-lived tokens)
   - Slack notifications? (optional)
   - Preview URLs with stable domains? (optional, needs Cloudflare API token)

## Phase 2: Configure repos.json

Based on their answers:

1. Read the current `repos.json` and `repos.example.json` to understand the format.
2. Edit `repos.json` with entries for their repositories.
3. For each repo, decide:
   - `bakeAmi: true` (heavy deps, Docker services) or `false` (lightweight, fast install)
   - `instanceType` based on their repo's resource needs
   - `scriptsDir` if they need custom boot scripts (explain when this is needed)
4. Use `docs/repos-json.md` to guide the conversation.

## Phase 3: Configure .env.local

1. Help them create `.env.local` from `.env.example`:
   ```bash
   cp .env.example .env.local
   ```
2. Walk through each section of `.env.example` and help them fill in values.
3. For each integration, read the corresponding guide from `docs/`:

### Linear (required)

- Guide: `docs/linear.md`
- They need to create: OAuth app + webhook in Linear Settings
- Collect: `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET`
- Callback URL: `https://<their-domain>/oauth/callback`
- Webhook URL: `https://<their-domain>/webhook`

### GitHub (required)

- Guide: `docs/github.md`
- `GITHUB_TOKEN` (PAT with repo scope) is always required for setup
- Recommend also setting up a GitHub App for agent operations — collect `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID`

### Claude Auth (required — one of two options)

- **Option 1: `CLAUDE_CODE_OAUTH_TOKEN`** — from Claude Code CLI auth config
- **Option 2: `ANTHROPIC_API_KEY`** — from the Anthropic console
- At least one must be set

### Slack (optional)

- Guide: `docs/slack.md`
- If they want notifications: collect `SLACK_BOT_TOKEN` and `SLACK_CHANNEL_ID`

### Preview URLs (optional)

- Guide: `docs/cloudflare.md`
- If they want live preview deployments: collect `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`

## Phase 4: Run setup.sh

Guide them to run:

```bash
bash scripts/setup.sh
```

This single command:
1. Creates AWS resources (security groups, S3 bucket, secrets, IAM, SSH key)
2. Pushes secrets from `.env.local` to AWS Secrets Manager
3. Launches orchestrator EC2
4. SSHes in: installs Node, pnpm, cloudflared, clones repo
5. Creates Cloudflare tunnel — **user clicks one URL to authorize**
6. Deploys orchestrator (build + start)
7. Health checks

If something fails, help them debug by reading the relevant script source code.

## Phase 5: Connect Linear

Visit `https://<their-domain>/oauth/install` (printed at the end of setup).

## Phase 6: Bake AMI (optional)

Only needed for repos with `bakeAmi: true` in `repos.json`.

```bash
ssh -i ~/.ssh/hermes-key.pem ubuntu@<ORCHESTRATOR_IP>
bash /opt/agent/hermes-swe/scripts/bake-ami.sh --repo org/repo
```

This takes 10-20 minutes and updates `/opt/agent/env` automatically.

Repos with `bakeAmi: false` don't need a custom AMI — they clone and install at boot time using the generic AMI.

## Phase 7: Verify

1. Assign a Linear ticket to the agent
2. Check orchestrator logs: `journalctl -u orchestrator -f`
3. Verify: agent EC2 launches, works on ticket, creates PR

## Notes

- If the user is missing prerequisites (AWS CLI, cloudflared), help them install what's needed.
- If something fails, read the relevant script source code to help debug.
- Reference specific docs pages when explaining integration details rather than repeating content.
