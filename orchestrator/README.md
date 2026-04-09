# Orchestrator

Manages the lifecycle of AI agent sessions triggered by Linear tickets. Receives Linear webhooks, provisions agent EC2 instances, forwards messages, handles completion callbacks, and cleans up resources.

Runs on a single t4g.nano EC2 instance behind a Cloudflare Tunnel.

## Session Lifecycle

```
                        webhook
                          │
                          ▼
queued ──(capacity)──▶ provisioning ──(agent-ready)──▶ running ──(callback)──▶ completed
   ▲                                                                          │  │
   │                                                                          │  │ (user message)
   └──────── drainQueue ──────────────────────────────────────────────────────┘  │
                                                                                 ▼
                                                                        provisioning (resume)
```

**States**: `queued` → `provisioning` → `running` → `completed` / `failed` / `stopped`

Completed/failed/stopped sessions keep their EC2 instance alive for a grace period (30 min default) to allow fast resume. After the grace period, the instance is terminated.

## Flows

### New Session

1. Linear webhook fires (ticket assigned to agent)
2. `handleSessionCreated` parses the event, checks idempotency
3. `sessionManager.startSession()` fetches branch name from Linear API, builds prompt
4. If at capacity → queue the session, post "Queued" to Linear
5. If slots available → create session record, call `provision()` (fire-and-forget)
6. `provision()` launches EC2 with user-data containing secrets + init script
7. Agent EC2 boots, runs `init-instance.sh`, calls `POST /agent-ready`
8. Orchestrator clears provision timeout, sends `POST /run` to agent-service with the prompt
9. Session transitions to `running`

### Message Forwarding

1. User sends message on Linear issue → `handleSessionPrompted` webhook
2. If session is `running` → forward via `POST /message` to agent-service
3. If session is `completed`/`failed`/`stopped` → trigger resume flow

### Resume

1. Try reusing the existing instance (grace period may still be active)
   - Clear grace-period termination timer
   - `POST /message` to agent-service — if it responds, session is resumed
2. If instance is gone → provision a new EC2 with `resumeAgentSessionId`
   - Previous session's Claude artifacts are downloaded from S3 to restore context

### Completion

1. Agent-service calls `POST /callback` with status + summary
2. Orchestrator updates session, schedules grace-period termination
3. On termination: cleans up Cloudflare tunnel + DNS record (if named tunnel was used), then terminates EC2
4. Posts status to Slack thread
5. Calls `drainQueue()` to provision next queued session if capacity is available

### Stop

1. User clicks stop in Linear → `session_prompted` webhook with stop signal
2. Orchestrator sends `POST /stop` to agent-service

### Recovery (on restart)

Runs before the server starts accepting connections:

1. **Running sessions** — poll `/health` on all running instances (in parallel, 5s timeout each)
   - Agent reports completed/failed → process as missed callback
   - Agent still running → leave alone
   - Agent unreachable → terminate instance, mark failed
2. **Provisioning sessions** — check if timeout has elapsed
   - Expired → terminate instance, mark failed
   - Time remaining → reschedule provision timeout
3. **Completed/failed/stopped with instance** — check grace period
   - Expired → terminate instance
   - Time remaining → reschedule termination timeout
4. **Drain queue** — provision any queued sessions if capacity is available

## HTTP Routes

| Method | Path | Source | Purpose |
|--------|------|--------|---------|
| POST | `/linear/webhooks` | Linear | Webhook endpoint (via LinearEventTransport) |
| POST | `/agent-ready` | Agent EC2 | Agent finished booting, ready for `/run` |
| POST | `/callback` | Agent EC2 | Session completed/failed/stopped |
| POST | `/session-update` | Agent EC2 | Store Claude CLI session ID (for resume) |
| POST | `/session-preview-url` | Agent EC2 | Store preview URL for the session |
| POST | `/session-artifacts` | Agent EC2 | Upload gzipped Claude project artifacts to S3 |
| GET | `/health` | Any | Health check |
| GET | `/oauth/install` | Browser | Start Linear OAuth app installation |
| GET | `/oauth/callback` | Linear | OAuth code exchange callback |

## Queue Management

Concurrency is capped at `MAX_CONCURRENT` (default 5). Sessions beyond the limit are queued with status `queued`. When a session completes, `drainQueue()` dequeues the oldest queued session and provisions it.

## Secrets (AWS Secrets Manager)

Fetched once at startup via `src/secrets.ts` and cached in memory. Passed to agent EC2 instances via user-data → `/opt/agent/env`.

| Key | Purpose | Passed to agent |
|-----|---------|-----------------|
| `GITHUB_TOKEN` | Git operations, gh CLI | Yes |
| `LINEAR_WEBHOOK_SECRET` | Verify Linear webhook signatures | No |
| `LINEAR_CLIENT_ID` | Linear OAuth (code exchange, token refresh) | No |
| `LINEAR_CLIENT_SECRET` | Linear OAuth (code exchange, token refresh) | No |
| `SLACK_BOT_TOKEN` | Post threaded messages to Slack | No |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code CLI authentication | One of these required |
| `ANTHROPIC_API_KEY` | Anthropic API key (alternative) | One of these required |
| `SENTRY_ACCESS_TOKEN` | Sentry MCP server authentication | Yes |
| `METABASE_API_KEY` | Metabase MCP server authentication | Yes |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API (Zone:DNS:Edit + Tunnel:Edit) | Yes |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID for preview tunnels | Yes |
| `CLOUDFLARE_ZONE_ID` | Cloudflare zone ID for preview domain | Yes |

MCP secrets (`SENTRY_ACCESS_TOKEN`, `METABASE_API_KEY`) flow to the agent process environment. The app repo's `.claude/.env.example` is copied to `.env.local` at boot for static MCP config (e.g. `SENTRY_HOST`); secrets pass through from the process env since `dotenv-cli` doesn't override existing variables.

## Source Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Fastify server, route handlers, webhook transport |
| `src/session-manager.ts` | `SessionManager` class — provisioning, timeouts, recovery, queue |
| `src/webhook-handler.ts` | Parse Linear webhook events, delegate to SessionManager |
| `src/session-store.ts` | S3-backed session state with in-memory cache |
| `src/linear-activity.ts` | Linear API client, post activity to issues |
| `src/linear-token.ts` | OAuth token management (exchange, refresh, persist) |
| `src/slack.ts` | Threaded Slack notifications |
| `src/ec2.ts` | EC2 launch/terminate via AWS SDK |
| `src/user-data.ts` | Generate base64 user-data script for agent EC2 |
| `src/config.ts` | Environment variable loading |
| `src/secrets.ts` | AWS Secrets Manager client |
| `src/types.ts` | SessionRecord, CompletionCallback types |
