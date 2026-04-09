# Repository Configuration

`repos.json` maps GitHub repositories to infrastructure configuration. It defines which repos the agent can work on, how to provision their environments, and what secrets/scripts they need.

## Location

`repos.json` at the repository root. Read by the orchestrator (TypeScript) and shell scripts (jq).

## Field Reference

| Field | Type | Required | Description |
|---|---|---|---|
| `amiName` | string | Yes | Unique name for AMI selection. Maps to `AGENT_AMI_ID_{NAME}` env var (uppercased). |
| `scriptsDir` | string | No | Relative path from repo root to repo-specific scripts (e.g. `"ami/my-app"`). |
| `workspaceDir` | string | Yes | Absolute path where the repo is cloned on the agent EC2 (e.g. `"/workspace/my-app"`). |
| `bakeAmi` | boolean | Yes | Whether this repo gets its own pre-baked AMI (`true`) or uses the shared default AMI (`false`). |
| `secrets` | string[] | Yes | Secret key names from AWS Secrets Manager to pass to the agent (e.g. `["SENTRY_ACCESS_TOKEN"]`). |
| `envExample` | string | No | Path to `.env.example` file in the repo (relative to repo root). Used to populate `.env.local` for MCP servers. |
| `instanceType` | string | Yes | EC2 instance type for agent instances (e.g. `"m6i.xlarge"`, `"m6i.large"`). |

## Example

```json
{
  "acme-corp/web-app": {
    "amiName": "web-app",
    "scriptsDir": "ami/web-app",
    "workspaceDir": "/workspace/web-app",
    "bakeAmi": true,
    "secrets": ["SENTRY_ACCESS_TOKEN"],
    "envExample": ".claude/.env.example",
    "instanceType": "m6i.xlarge"
  },
  "acme-corp/api-service": {
    "amiName": "default",
    "scriptsDir": "ami/api-service",
    "workspaceDir": "/workspace/api-service",
    "bakeAmi": false,
    "secrets": [],
    "instanceType": "m6i.large"
  }
}
```

## Adding a New Repository

### Minimal setup (no custom scripts, shared AMI)

1. Add an entry to `repos.json`:

```json
{
  "your-org/your-repo": {
    "amiName": "default",
    "workspaceDir": "/workspace/your-repo",
    "bakeAmi": false,
    "secrets": [],
    "instanceType": "m6i.xlarge"
  }
}
```

2. Ensure the `AGENT_AMI_ID_DEFAULT` env var is set on the orchestrator (bake with `bake-ami.sh` without `--repo`).

3. Restart the orchestrator: `sudo systemctl restart orchestrator`

That's it. The agent will clone the repo at boot time and work on it.

### Full setup (custom scripts, dedicated AMI)

1. Add an entry with `bakeAmi: true` and a unique `amiName`:

```json
{
  "your-org/your-repo": {
    "amiName": "your-repo",
    "scriptsDir": "ami/your-repo",
    "workspaceDir": "/workspace/your-repo",
    "bakeAmi": true,
    "secrets": ["YOUR_SECRET"],
    "envExample": ".claude/.env.example",
    "instanceType": "m6i.xlarge"
  }
}
```

2. Create repo-specific scripts in `ami/your-repo/` (see [Repo-Specific Scripts](#repo-specific-scripts) below).

3. Bake the AMI:

```bash
bash scripts/bake-ami.sh --repo your-org/your-repo
```

This sets `AGENT_AMI_ID_YOUR_REPO` in the orchestrator's `/opt/agent/env`.

4. Restart the orchestrator: `sudo systemctl restart orchestrator`

---

## AMI Strategy

### `bakeAmi: false` — Shared Default AMI

The repo is cloned fresh at boot time. Good for:
- Repos with fast installs (no heavy build step)
- Repos that don't need Docker services
- Getting started quickly

Boot time: ~3-5 minutes (clone + install + build happens at boot).

### `bakeAmi: true` — Dedicated Pre-Baked AMI

The repo is pre-cloned and built into the AMI. At boot, only `git pull` and incremental builds are needed. Good for:
- Repos with heavy dependencies (large `node_modules`, Docker images)
- Repos that need Docker services running at boot
- Faster boot times (~2 minutes)

### How AMI Selection Works

Each `amiName` maps to an environment variable on the orchestrator:

```
amiName: "web-app"  →  AGENT_AMI_ID_WEB_APP=ami-0abc123
amiName: "default"  →  AGENT_AMI_ID_DEFAULT=ami-0def456
```

The orchestrator reads these env vars at startup and selects the correct AMI when launching an agent for each repo.

---

## Repo-Specific Scripts

The `scriptsDir` field points to a directory containing scripts that customize the agent environment. The path is relative to the repository root (e.g. `"ami/my-app"`).

### Available Scripts

| Script | Runs During | Purpose |
|---|---|---|
| `setup.sh` | AMI baking | Install system dependencies (apt packages, Docker image pulls, etc.) |
| `prepare.sh` | AMI baking | Build the repo, install deps, run Docker compose build |
| `pre-agent.sh` | Instance boot (before agent-service) | Start services needed by MCP servers (e.g. databases) |
| `post-agent.sh` | Instance boot (after agent-service) | Start remaining services, run builds |
| `allowed-domains.txt` | Instance boot | Additional firewall domains (appended to base allowlist) |
| `launch.json` | Instance boot | Preview configurations (see [Preview System](#preview-system)) |
| `preview/` | Instance boot | Preview scripts referenced by launch.json |

### Directory structure

```
ami/your-repo/
├── setup.sh              # AMI bake: system deps
├── prepare.sh            # AMI bake: build repo
├── pre-agent.sh          # Boot: before agent-service
├── post-agent.sh         # Boot: after agent-service
├── allowed-domains.txt   # Boot: extra firewall domains
├── launch.json           # Boot: preview configurations
└── preview/              # Boot: preview scripts
    └── dev-server.sh
```

### When Scripts Run

**During AMI baking** (`bake-ami.sh --repo your-org/your-repo`):

1. `ami/setup.sh` (base) — installs Docker, Node.js, pnpm, Claude Code
2. `ami/your-repo/setup.sh` — your repo-specific system dependencies
3. `ami/prepare-ami.sh` — clones repos, runs your `prepare.sh`, installs systemd service

**During instance boot** (`init-instance.sh`):

1. Pull latest code (git pull)
2. Apply firewall + append `allowed-domains.txt`
3. Copy `launch.json` and `preview/` to workspace `.claude/`
4. Run `pre-agent.sh`
5. Start agent-service
6. Run `post-agent.sh`

### Example: setup.sh

```bash
#!/bin/bash
set -euo pipefail

# Pull Docker images that the app needs
docker pull postgres:16
docker pull redis:alpine

# Install app-specific system packages
apt-get update && apt-get install -y libpq-dev
```

### Example: pre-agent.sh

```bash
#!/bin/bash
set -euo pipefail

WORKSPACE_DIR="${WORKSPACE_DIR:-/workspace/your-repo}"

# Start database early — MCP servers need it
cd "$WORKSPACE_DIR"
docker compose up -d postgres
sleep 5  # Wait for Postgres to be ready
```

### Example: post-agent.sh

```bash
#!/bin/bash
set -euo pipefail

WORKSPACE_DIR="${WORKSPACE_DIR:-/workspace/your-repo}"
cd "$WORKSPACE_DIR"

# Start all services
docker compose up -d

# Install and build
npm install --frozen-lockfile
npm run build
```

---

## Preview System

The preview system lets the agent create live, publicly accessible preview URLs for code changes. It uses `.claude/launch.json` to define how to start preview servers and Cloudflare tunnels to expose them.

### How It Works

1. At boot, `init-instance.sh` copies `launch.json` and `preview/` from `scriptsDir` into the workspace's `.claude/` directory
2. After pushing code, the agent uses the `/preview` skill to run the preview
3. `preview-launch.sh` reads the launch.json, starts the server, creates a Cloudflare tunnel
4. The preview URL is posted to the Linear ticket

### launch.json Format

```json
{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "dev-server",
      "default": true,
      "program": "preview/dev-server.sh",
      "port": 3000
    },
    {
      "name": "storybook",
      "program": "preview/storybook.sh",
      "args": ["--ci"],
      "port": 6006
    }
  ]
}
```

### Configuration Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Unique name for this configuration |
| `default` | boolean | No | If true, this config is used when no name is specified |
| `program` | string | Yes* | Script to run, relative to `.claude/` directory |
| `args` | string[] | No | Arguments passed to the program |
| `port` | number | Yes | Port the server listens on (tunneled to public URL) |
| `runtimeExecutable` | string | Yes* | Alternative to `program` — direct executable path |
| `runtimeArgs` | string[] | No | Arguments for `runtimeExecutable` |

*Either `program` or `runtimeExecutable` is required.

### Path Resolution

The `program` field is relative to the `.claude/` directory in the workspace:

```
program: "preview/dev-server.sh"
→ runs: bash /workspace/your-repo/.claude/preview/dev-server.sh
```

### Preview Script Example

```bash
#!/bin/bash
# preview/dev-server.sh
set -euo pipefail

WORKSPACE_DIR="${WORKSPACE_DIR:-/workspace/your-repo}"
cd "$WORKSPACE_DIR"

# Rebuild
npm run build

# Start dev server
npm run start
```

### Cloudflare Tunnel for Previews

Named tunnels require these env vars on the orchestrator (passed to agents):
- `CLOUDFLARE_API_TOKEN` — with Zone:DNS:Edit and Account:Cloudflare Tunnel:Edit permissions
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_ZONE_ID`
- `PREVIEW_DOMAIN` — base domain for preview URLs (e.g. `example.com`)

Preview URLs follow the pattern: `https://preview-{session-id-prefix}-{config-name}.example.com`

Without these env vars, the system falls back to temporary quick tunnels (`*.trycloudflare.com` URLs).

See [Cloudflare Setup](cloudflare.md) for configuration details.

---

## Secrets

The `secrets` array lists secret key names from AWS Secrets Manager that should be passed to the agent EC2 instance:

```json
{
  "secrets": ["SENTRY_ACCESS_TOKEN", "METABASE_API_KEY"]
}
```

These secrets are:
1. Fetched from Secrets Manager by the orchestrator at startup
2. Written to `/opt/agent/env` on the agent EC2 via user-data
3. Available as environment variables to all scripts and agent-service

### MCP Server Configuration

MCP servers get their configuration from two sources:

**Secrets** (API tokens, credentials) — passed via environment variables:

1. Add the secret key names to the `secrets` array in `repos.json`
2. Add the actual values to AWS Secrets Manager
3. At boot, secrets are written to `/opt/agent/env` and available as environment variables to all processes — including MCP servers spawned by Claude Code

**Non-secret config** (URLs, project IDs, service endpoints) — passed via `.env.local`:

1. Create a `.claude/.env.example` in your repo with the static config values:

```env
SENTRY_ORG_SLUG=your-org
SENTRY_PROJECT_SLUG=your-project
METABASE_URL=https://metabase.example.com
```

2. Set `envExample` in `repos.json` to point to this file:

```json
{
  "envExample": ".claude/.env.example"
}
```

3. At boot, `.env.example` is copied to `.env.local` in the same directory — MCP servers that read dotenv files pick up the config from there.
