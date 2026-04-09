# Agent Service

Runs on each agent EC2 instance. Manages a Claude Code CLI session that works on a Linear ticket — starts the session, streams progress back to Linear, handles user messages, and reports completion to the orchestrator.

## Session Lifecycle

```
[Idle]
  │ POST /run
  ▼
[Starting] ── launchRunner() creates ClaudeRunner, starts streaming
  │
  ▼
[Running] ── Claude is working (tool calls, reasoning, writing code)
  │           ├── onMessage → buffer thoughts, capture Claude session ID
  │           ├── tool-use  → report action to Linear
  │           ├── /message  → inject user text into stream
  │           └── /stop     → graceful shutdown
  │
  ▼
[Completed / Failed]
  │  ├── report final message to Linear
  │  ├── upload artifacts to orchestrator (S3)
  │  └── POST /callback to orchestrator
  │
  │ POST /message (on completed/failed session)
  ▼
[Starting] ── resume with previous Claude session ID
```

## Flows

### Start

1. Orchestrator sends `POST /run` with prompt, session IDs, branch, issue context
2. `SessionManager.start()` creates a `ClaudeRunner` with the system prompt
3. Runner starts streaming — Claude reads the codebase, runs tests, writes code, creates PRs
4. On first `init` message, the Claude session ID is sent to orchestrator via `POST /session-update`

### Progress Reporting

As Claude works, the service reports to Linear in real-time:

- **Thoughts** — intermediate reasoning (buffered until next tool use or completion)
- **Actions** — tool executions (bash commands, file reads/writes, grep, etc.)
- **Response** — final completion message (the last buffered thought)
- **Error** — if the session fails

PR URLs are detected automatically (from `gh pr create` output) and attached to the Linear session.

### Preview Build

When a `git push` is detected in a Bash tool call:

1. `PostToolUse` hook triggers `triggerPreviewBuild()`
2. Runs `ami/preview-build.sh` which sources the repo-specific `ami/<AMI_NAME>/preview.sh` (build + restart) then creates a named Cloudflare tunnel
3. Preview URL (`https://preview-{id}.yourdomain.com`) is attached to Linear and reported to orchestrator

### Message Injection

When a user sends a message on the Linear issue while the agent is running:

1. Orchestrator forwards via `POST /message`
2. If running → `runner.addStreamMessage()` injects text into the active Claude conversation
3. If completed/failed → auto-resumes the session with the message as a new prompt

### Resume

1. `POST /message` arrives on a completed/failed session
2. Look up the Claude session ID from the local session store
3. Launch a new runner with `resumeSessionId` — Claude continues the previous conversation
4. Artifacts from the previous session (restored from S3 during boot) provide project memory

### Stop

1. `POST /stop` triggers `runner.stop()` — Claude receives a graceful shutdown signal
2. Session transitions to `Completed`
3. Final message reported to Linear, artifacts uploaded, orchestrator notified

### Completion

1. Claude finishes (or hits max turns, or errors out)
2. Pending thoughts are flushed and reported
3. `~/.claude/projects/` is tarred and uploaded to orchestrator (`POST /session-artifacts`)
4. Orchestrator is notified via `POST /callback` with status and summary

## HTTP Routes

| Method | Path | Source | Purpose |
|--------|------|--------|---------|
| POST | `/run` | Orchestrator | Start a new Claude session with prompt |
| POST | `/message` | Orchestrator | Send user message to running session, or resume |
| POST | `/stop` | Orchestrator | Gracefully stop the running session |
| GET | `/health` | Orchestrator | Health check (returns session state) |

## Outbound Calls to Orchestrator

| Endpoint | When | Purpose |
|----------|------|---------|
| `POST /agent-ready` | On boot | Signal that agent-service is ready for `/run` |
| `POST /session-update` | On session start | Store Claude CLI session ID for resume |
| `POST /session-artifacts` | Before completion | Upload `~/.claude/projects/` tarball |
| `POST /callback` | On completion | Report status (completed/failed/stopped) + summary |
| `POST /session-preview-url` | After git push | Report preview URL for the session |

## Linear Reporting

Activity is posted to Linear via `LinearIssueTrackerService.createAgentActivity()`:

| Type | When | Content |
|------|------|---------|
| Thought (ephemeral) | Session starting | "Starting Claude Code..." |
| Action | Tool use | Tool name + summarized input |
| Thought | Between tool uses | Buffered assistant reasoning |
| Response | Completion | Final assistant message |
| Error | Failure | Error message |

Retries with exponential backoff (1s, 2s, 4s) for transient failures. Sessions that return "Entity not found" are marked dead to prevent retry loops.

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | 3000 | Listen port |
| `WORKSPACE_DIR` | `/workspace/app` | Working directory for Claude |
| `LOGS_DIR` | `/home/ubuntu/.cyrus` | Claude CLI logs and session store |
| `CLAUDE_PROJECTS_DIR` | `/home/ubuntu/.claude/projects` | Claude project memory |
| `CLAUDE_MODEL` | `opus` | Claude model to use |
| `MAX_TURNS` | 200 | Max tool-use turns before stopping |
| `LINEAR_OAUTH_ACCESS_TOKEN` | *required* | Linear API authentication |
| `ORCHESTRATOR_URL` | — | Orchestrator base URL for callbacks |
| `AGENT_SESSION_ID` | — | Used in startup `/agent-ready` notification |
| `SENTRY_ACCESS_TOKEN` | — | Passed through to MCP servers via process env |
| `METABASE_API_KEY` | — | Passed through to MCP servers via process env |
| `PREVIEW_UI` | `false` | Enable preview build on git push |
| `AMI_NAME` | — | AMI name for locating repo-specific preview.sh |
| `PREVIEW_DOMAIN` | — | Domain for named tunnel URLs (e.g. `yourdomain.com`) |
| `CLOUDFLARE_API_TOKEN` | — | Cloudflare API token for tunnel creation |
| `CLOUDFLARE_ACCOUNT_ID` | — | Cloudflare account ID |
| `CLOUDFLARE_ZONE_ID` | — | Cloudflare zone ID for DNS records |

## Source Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point — starts HTTP server, sends `/agent-ready` |
| `src/server.ts` | HTTP server with `/run`, `/message`, `/stop`, `/health` routes |
| `src/session.ts` | `SessionManager` — Claude runner lifecycle, state machine |
| `src/linear-reporter.ts` | Post activity to Linear, PR URL detection, retry logic |
| `src/session-store.ts` | Local JSON file mapping agent sessions → Claude session IDs |
| `src/prompt-loader.ts` | Load and resolve system prompt from `prompts/system.md` |
| `src/types.ts` | Shared type definitions |
| `prompts/system.md` | System prompt — environment context, workflow routing to skills |
