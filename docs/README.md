# Documentation

AI coding agent infrastructure that autonomously works on Linear tickets. Assign a ticket, and it spins up a sandboxed EC2 dev environment with Claude Code, writes code, runs tests, and opens a PR — streaming progress back to Linear in real time.

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

## How It Works

1. A Linear ticket is assigned to the agent
2. Linear fires a webhook → Cloudflare Tunnel → Orchestrator
3. Orchestrator launches an EC2 instance from a pre-baked AMI
4. The instance boots (~2 min): pulls latest code, starts Docker stack, applies firewall
5. Agent-service starts a Claude Code session with the ticket as the prompt
6. Claude reads the codebase, plans an approach, writes code, runs tests
7. Progress is streamed to Linear as activity updates (thoughts, actions, completions)
8. On completion: a PR is created, the EC2 is terminated, Slack is notified
9. Follow-up comments on the ticket resume the session — reusing the instance if still alive

## Prerequisites

| Requirement | Purpose | Required? |
|---|---|---|
| AWS account | EC2 compute, S3 state, Secrets Manager, IAM | Yes |
| Domain name | Webhook ingress via Cloudflare Tunnel | Yes |
| Linear workspace | Ticket management, webhook triggers | Yes |
| GitHub organization | Code hosting, PR creation | Yes |
| Claude Code token | AI coding agent | Yes |
| Cloudflare account | Tunnel for webhooks, optional preview URLs | Yes |
| Slack workspace | Session notifications (DMs to ticket creators) | No |
| Sentry account | Error tracking MCP server for the agent | No |
| Metabase instance | Data analytics MCP server for the agent | No |

## Quick Start

See the **[Self-Hosting Guide](self-hosting.md)** for end-to-end setup instructions.

## Guides

| Guide | Description |
|---|---|
| [Self-Hosting Guide](self-hosting.md) | End-to-end setup: from fork to first ticket |
| [Repository Configuration](repos-json.md) | How `repos.json` works, adding repos, AMI strategy, previews |
| [Linear Integration](linear.md) | OAuth app setup, webhooks, activity reporting |
| [GitHub Authentication](github.md) | GitHub App (recommended) or Personal Access Token |
| [Cloudflare Setup](cloudflare.md) | Orchestrator tunnel + optional preview tunnels |
| [Slack Notifications](slack.md) | Bot setup for threaded DM notifications |

## Reference

- [SETUP.md](../SETUP.md) — Quick-reference setup cheatsheet (concise, for experienced users)
- [CLAUDE.md](../CLAUDE.md) — Detailed architecture, data storage, network security, environment variables
