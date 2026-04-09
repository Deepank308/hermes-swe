# Hermes

> Autonomous AI coding agent triggered by Linear tickets. Assign a ticket, get a PR — with a full dev environment, live preview URLs, and real-time progress streamed back to Linear.

![Claude Code](https://img.shields.io/badge/Claude_Code-000?style=flat&logo=anthropic&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white)
![AWS EC2](https://img.shields.io/badge/AWS_EC2-FF9900?style=flat&logo=amazon-ec2&logoColor=white)
![Cloudflare](https://img.shields.io/badge/Cloudflare-F38020?style=flat&logo=cloudflare&logoColor=white)
![Linear](https://img.shields.io/badge/Linear-5E6AD2?style=flat&logo=linear&logoColor=white)
![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)

> **Getting started?** Fork this repo, open it in [Claude Code](https://claude.ai/code), and run `/setup`. It walks you through everything.

---

<p align="center">
  <video src="https://github.com/user-attachments/assets/2450582c-4ba8-477e-84e6-835e9c069d90" width="800" autoplay loop muted>
  </video>
</p>

## What Is This

Hermes turns Linear tickets into pull requests. You assign a ticket to the agent, and it:

1. **Spins up a full dev environment** — EC2 with Docker, PostgreSQL, Redis, OpenSearch, your entire app stack
2. **Reads the codebase, plans an approach, writes code, runs tests**
3. **Streams progress** back to the Linear ticket as activity updates
4. **Creates a preview URL** — a live, accessible deployment of the changes
5. **Opens a PR** when done, terminates the instance, and notifies Slack

You can send messages mid-flight via Linear comments — Hermes reads and responds in real-time.

> **This is not a copilot.** Hermes is an autonomous agent that works independently on tickets. You review the PR, not the keystrokes.

Built and used in production to handle engineering tickets end-to-end.

## Demo

### Hermes can ask clarifying questions

<p align="center">
<video src="https://github.com/user-attachments/assets/1dee4448-e789-4ee3-80aa-e9e2f78413d1" width="800" autoplay loop muted></video>
</p>

### The PR it created — from Linear straight to GitHub

<p align="center">
<video src="https://github.com/user-attachments/assets/1642af98-4b3b-4a08-9731-739aa7cdcf80" width="800" autoplay loop muted></video>
</p>

## Features

| Feature                   | Description                                                                                                                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Automated workflows**   | Classifies tickets and applies the right skill — `full-development` (plan → TDD → PR), `debugging` (investigate → fix → PR), or `simple-question` (research → answer) |
| **Full dev environment**  | Each session gets its own EC2 with Docker, databases, and the complete app stack                                                                                      |
| **Bi-directional Linear** | Progress streamed to tickets, user comments forwarded to the agent mid-flight                                                                                         |
| **Preview URLs**          | Named Cloudflare tunnels with stable subdomains for live preview environments                                                                                         |
| **Session resume**        | Follow-up comment on a completed ticket resumes where it left off                                                                                                     |
| **Pre-baked AMIs**        | Agent EC2 instances boot in ~2 minutes with everything pre-installed                                                                                                  |
| **Outbound firewall**     | iptables allowlist restricts agent internet access to approved domains only                                                                                           |
| **Network isolation**     | Agents only accept inbound traffic from the orchestrator security group                                                                                               |
| **Queued sessions**       | Configurable concurrency cap with automatic queue draining                                                                                                            |
| **Crash recovery**        | On restart, in-flight sessions are reconciled and the queue is drained                                                                                                |
| **MCP integrations**      | Plug in any MCP servers (e.g. error tracking, analytics) for richer agent context                                                                                     |
| **Slack notifications**   | Threaded session updates posted to a Slack channel                                                                                                                    |
| **GitHub App auth**       | Short-lived installation tokens with automatic refresh                                                                                                                |
| **Multi-org Linear**      | Per-organization OAuth tokens with automatic refresh                                                                                                                  |

## How It Works

```
You assign a Linear ticket
        │
        ▼
┌──────────────────┐
│  Orchestrator    │  Receives webhook, launches EC2 from pre-baked AMI
│  (t4g.nano)      │
└────────┬─────────┘
         │
┌────────▼─────────┐
│  Agent EC2       │  Boots in ~2min, starts Docker stack + agent-service
│  (m6i.xlarge)    │
└────────┬─────────┘
         │
    ┌────┼────┐
    ▼    ▼    ▼
 Linear  PR  Slack
 updates .git notification
```

**The full flow:**

1. Linear ticket assigned to agent → webhook fires
2. Orchestrator receives webhook via Cloudflare Tunnel
3. Orchestrator launches agent EC2 from pre-baked AMI
4. Agent EC2 boots: pulls code, starts Docker stack, starts agent-service
5. Claude Code reads the codebase, plans, codes, tests
6. Progress streamed to Linear as activity updates
7. Preview URL created via Cloudflare named tunnel
8. PR opened, EC2 terminated, Slack notified

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

```
hermes-swe/
├── orchestrator/         # Webhook receiver, EC2 lifecycle, session queue
├── agent-service/        # Runs on agent EC2 — Claude Code session management
├── skills/               # Workflow skills copied to each agent at boot
│   ├── full-development/ # Features, enhancements, refactors
│   ├── debugging/        # Bug reports, error investigations
│   └── simple-question/  # Questions, clarifications
├── ami/                  # EC2 provisioning, AMI baking, firewall
│   ├── setup.sh          # Base AMI: Docker, Node, pnpm, Claude Code
│   ├── prepare-ami.sh    # Pre-bake: clone repos, build, pull images
│   ├── init-instance.sh  # Boot-time: pull latest, start services
│   ├── firewall.sh       # Outbound domain allowlist
│   └── app/              # Example app-specific scripts
├── scripts/              # AWS setup, deployment, AMI baking
├── repos.json            # Maps org/repo → AMI, instance type, secrets
└── package.json          # pnpm workspace
```

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/Deepank308/hermes-swe.git
cd hermes-swe && pnpm install

# 2. Configure
cp .env.example .env.local
# Fill in: CLOUDFLARE_HOSTNAME, LINEAR_*, CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY, GITHUB_TOKEN
# Edit repos.json to add your repositories (see repos.example.json)

# 3. Run setup (creates AWS resources, launches EC2, sets up tunnel)
bash scripts/setup.sh
# You'll click one URL to authorize Cloudflare — that's the only interactive step

# 4. Connect Linear — visit the URL printed at the end of setup

# 5. Assign a ticket — Hermes takes it from here
```

> **Have Claude Code installed?** Run `/setup` in this repo for an interactive guided setup.

See [SETUP.md](SETUP.md) for the full setup guide.

## Integrations

| Service                                                                                             | Role                                                                   |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [Linear](https://linear.app)                                                                        | Ticket management, webhook triggers, bi-directional activity streaming |
| [Claude Code](https://claude.ai/code)                                                               | AI coding agent (runs on agent EC2)                                    |
| [GitHub](https://github.com)                                                                        | Code hosting, PR creation, App-based authentication                    |
| [AWS EC2](https://aws.amazon.com/ec2/)                                                              | Agent compute (m6i.xlarge per session)                                 |
| [AWS S3](https://aws.amazon.com/s3/)                                                                | Session state persistence                                              |
| [AWS Secrets Manager](https://aws.amazon.com/secrets-manager/)                                      | Centralized secrets                                                    |
| [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) | HTTPS ingress + preview URLs                                           |
| [Slack](https://slack.com)                                                                          | Session notifications (optional)                                       |

## Tech Stack

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat&logo=node.js&logoColor=white)
![Claude Code](https://img.shields.io/badge/Claude_Code-000?style=flat&logo=anthropic&logoColor=white)
![AWS](https://img.shields.io/badge/AWS-FF9900?style=flat&logo=amazon-aws&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=flat&logo=docker&logoColor=white)

- **Orchestrator**: TypeScript + Fastify, runs on t4g.nano (~$3/mo)
- **Agent service**: TypeScript, manages Claude Code sessions via [cyrus](https://github.com/ceedaragents/cyrus)
- **Agent compute**: EC2 m6i.xlarge (16GB RAM) with Docker, full app stack
- **Networking**: Cloudflare Tunnel (webhooks) + named tunnels (preview URLs)
- **State**: S3 (sessions) + Secrets Manager (credentials)

## Built On Cyrus

Hermes uses [Cyrus](https://github.com/ceedaragents/cyrus) for Claude Code session management — starting, stopping, resuming, and streaming Claude CLI sessions programmatically. Cyrus handles the low-level session lifecycle so Hermes can focus on orchestration, workflow routing, and infrastructure.

## Development

```bash
pnpm install    # Install all workspace dependencies
pnpm build      # Build all packages
pnpm -r lint    # Lint all packages
```

Set `DRY_RUN=true` in `orchestrator/.env` to run locally without AWS resources.

## Documentation

| Guide                                          | Description                                   |
| ---------------------------------------------- | --------------------------------------------- |
| **[Setup Guide](SETUP.md)**                    | End-to-end setup from scratch                 |
| [Self-Hosting Guide](docs/self-hosting.md)     | Detailed deployment walkthrough               |
| [Repository Configuration](docs/repos-json.md) | Adding repos, AMI strategy, previews          |
| [Linear Integration](docs/linear.md)           | OAuth app setup, webhooks, activity reporting |
| [GitHub Authentication](docs/github.md)        | GitHub App or Personal Access Token           |
| [Cloudflare Setup](docs/cloudflare.md)         | Orchestrator tunnel + preview tunnels         |
| [Slack Notifications](docs/slack.md)           | Bot setup for threaded notifications          |

## Disclaimer

Hermes uses Claude Code CLI to run autonomous coding sessions. Per [Anthropic's Agent SDK guidelines](https://code.claude.com/docs/en/agent-sdk/overview), third-party products should authenticate with an **Anthropic API key** — configure `ANTHROPIC_API_KEY` in your `.env.local`.

Hermes is an independent open-source project, not affiliated with or endorsed by Anthropic. Please review Anthropic's [usage policy](https://www.anthropic.com/legal/aup) and [commercial terms](https://www.anthropic.com/legal/commercial-terms) to ensure your usage is compliant.

## License

MIT
