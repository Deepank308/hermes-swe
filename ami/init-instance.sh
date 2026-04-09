#!/bin/bash
set -euo pipefail
IFS=$'\n\t'

# Instance init script — called by orchestrator user-data after writing /opt/agent/env
# Pre-baked on the AMI at /opt/agent/hermes-swe/ami/init-instance.sh
# Runs as root (user-data always executes as root)
#
# Usage: init-instance.sh [branch] [port]
#   branch — git branch to checkout (defaults to pulling current branch)
#   port   — agent-service port (defaults to 3000)
#
# REPO and WORKSPACE_DIR come from /opt/agent/env (written by orchestrator user-data).

# Save args before sourcing env (env file must not clobber explicit args)
ARG_BRANCH="${1:-}"
ARG_PORT="${2:-}"

# cloud-init user-data may not set HOME — git config --global needs it
export HOME="${HOME:-/root}"

INSTALL_DIR="/opt/agent/hermes-swe"
REPOS_JSON="$INSTALL_DIR/repos.json"

echo "=== AI Agent - Instance Init ==="
echo "Starting at $(date)"

# ---------------------------------------------------------------------------
# Step 1: Source env vars
# ---------------------------------------------------------------------------
echo ""
echo ">>> Step 1: Loading environment variables..."

if [ ! -f /opt/agent/env ]; then
  echo "ERROR: /opt/agent/env not found — orchestrator user-data must write it before calling this script"
  exit 1
fi

set -a
source /opt/agent/env
set +a

# Args take priority over env file values
APP_BRANCH="${ARG_BRANCH:-${APP_BRANCH:-}}"
PORT="${ARG_PORT:-${PORT:-3000}}"

echo "Environment loaded."

# ---------------------------------------------------------------------------
# Step 2: Configure GitHub auth
# ---------------------------------------------------------------------------
echo ""
echo ">>> Step 2: Configuring GitHub auth..."

if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "ERROR: GITHUB_TOKEN not set — pass it as an env var to this script"
  exit 1
fi

# Single source of truth: gh CLI hosts.yml
# Both gh CLI (natively) and git (via gh auth git-credential) read from this file.
# Agent-service refreshes the token by writing only this file.
sudo -u ubuntu mkdir -p /home/ubuntu/.config/gh
cat > /home/ubuntu/.config/gh/hosts.yml <<GHEOF
github.com:
    oauth_token: $GITHUB_TOKEN
    git_protocol: https
GHEOF
chown -R ubuntu:ubuntu /home/ubuntu/.config/gh
chmod 600 /home/ubuntu/.config/gh/hosts.yml

# Configure git to use gh as credential helper (reads from hosts.yml above)
GH_PATH="$(which gh)"
git config --global credential."https://github.com".helper ''
git config --global --add credential."https://github.com".helper "!${GH_PATH} auth git-credential"
sudo -u ubuntu git config --global credential."https://github.com".helper ''
sudo -u ubuntu git config --global --add credential."https://github.com".helper "!${GH_PATH} auth git-credential"

# Mark agent-infra as safe (WORKSPACE_DIR added after repo config resolution below)
git config --global --add safe.directory /opt/agent/hermes-swe
sudo -u ubuntu git config --global --add safe.directory /opt/agent/hermes-swe

# Rewrite SSH git URLs to HTTPS so pre-commit can fetch private repos
sudo -u ubuntu git config --global url."https://github.com/".insteadOf "git@github.com:"

# gh CLI uses GITHUB_TOKEN/GH_TOKEN env vars automatically — no gh auth login needed

echo "GitHub auth configured."

# ---------------------------------------------------------------------------
# Step 3: Pull latest agent-infra code and rebuild
# ---------------------------------------------------------------------------
echo ""
echo ">>> Step 3: Pulling latest agent-infra code..."

cd /opt/agent/hermes-swe
AGENT_INFRA_BRANCH="${AGENT_INFRA_BRANCH:-}"
if [ -n "$AGENT_INFRA_BRANCH" ]; then
  echo "Checking out agent-infra branch: $AGENT_INFRA_BRANCH"
  git fetch origin "$AGENT_INFRA_BRANCH"
  git checkout "$AGENT_INFRA_BRANCH"
fi
git pull --ff-only
CI=true pnpm install --frozen-lockfile --filter agent-service
pnpm --filter agent-service build

echo "Agent-infra code updated and rebuilt."

# ---------------------------------------------------------------------------
# Resolve repo config from repos.json (AFTER git pull so we use latest config)
# ---------------------------------------------------------------------------
echo ""
echo ">>> Resolving repo config..."

if [ -z "$REPO" ]; then
  echo "ERROR: REPO not set — orchestrator must set it in /opt/agent/env"
  exit 1
fi

REPO_CONFIG=$(jq -r --arg repo "$REPO" '.[$repo] // empty' "$REPOS_JSON")
if [ -z "$REPO_CONFIG" ]; then
  echo "ERROR: Repo '$REPO' not found in repos.json"
  echo "  Available repos: $(jq -r 'keys | join(", ")' "$REPOS_JSON")"
  exit 1
fi

REPO_AMI=$(echo "$REPO_CONFIG" | jq -r '.amiName')
ENV_EXAMPLE=$(echo "$REPO_CONFIG" | jq -r '.envExample // ".claude/.env.example"')

# Resolve repo-specific scripts directory (no fallback — repos without scriptsDir get no custom scripts)
SCRIPTS_DIR=$(echo "$REPO_CONFIG" | jq -r '.scriptsDir // empty')
if [ -n "$SCRIPTS_DIR" ] && [ -d "$INSTALL_DIR/$SCRIPTS_DIR" ]; then
  REPO_SCRIPTS="$INSTALL_DIR/$SCRIPTS_DIR"
else
  REPO_SCRIPTS=""
fi

# Mark workspace as safe for git
git config --global --add safe.directory "$WORKSPACE_DIR"
sudo -u ubuntu git config --global --add safe.directory "$WORKSPACE_DIR"

echo "Repo: ${REPO:-NULL}"
echo "Repo AMI: $REPO_AMI"
echo "Scripts: ${REPO_SCRIPTS:-none}"
echo "Workspace: $WORKSPACE_DIR"

# ---------------------------------------------------------------------------
# Step 4: Pull latest repo code
# ---------------------------------------------------------------------------
echo ""
echo ">>> Step 4: Pulling latest repo code..."

if [ -d "$WORKSPACE_DIR/.git" ]; then
  cd "$WORKSPACE_DIR"
  git pull --ff-only
  if [ -n "$APP_BRANCH" ]; then
    if git fetch origin "$APP_BRANCH" 2>/dev/null; then
      echo "Checking out existing branch: $APP_BRANCH"
      git checkout -B "$APP_BRANCH" "origin/$APP_BRANCH"
    else
      echo "Creating new branch: $APP_BRANCH"
      git checkout -b "$APP_BRANCH"
    fi
  fi
  echo "Repo code updated."
elif [ -n "$REPO" ]; then
  echo "Repo not pre-cloned — cloning $REPO..."
  mkdir -p "$(dirname "$WORKSPACE_DIR")"
  gh repo clone "$REPO" "$WORKSPACE_DIR"
  cd "$WORKSPACE_DIR"
  if [ -n "$APP_BRANCH" ]; then
    if git fetch origin "$APP_BRANCH" 2>/dev/null; then
      echo "Checking out existing branch: $APP_BRANCH"
      git checkout -B "$APP_BRANCH" "origin/$APP_BRANCH"
    else
      echo "Creating new branch: $APP_BRANCH"
      git checkout -b "$APP_BRANCH"
    fi
  fi
  echo "Repo cloned."
else
  echo "No repo specified and no pre-cloned repo — skipping."
fi

# ---------------------------------------------------------------------------
# Step 4b: Configure git identity (requires workspace to exist)
# ---------------------------------------------------------------------------
echo ""
echo ">>> Step 4b: Configuring git identity..."

if [ -d "$WORKSPACE_DIR/.git" ]; then
  BOT_INFO=$(curl -sf -H "Authorization: bearer $GITHUB_TOKEN" \
    https://api.github.com/graphql \
    -d '{"query": "{ viewer { login databaseId } }"}')
  BOT_LOGIN=$(echo "$BOT_INFO" | jq -r '.data.viewer.login')
  BOT_ID=$(echo "$BOT_INFO" | jq -r '.data.viewer.databaseId')
  if [ "$BOT_LOGIN" != "null" ] && [ -n "$BOT_LOGIN" ]; then
    git -C "$WORKSPACE_DIR" config user.name "$BOT_LOGIN"
    git -C "$WORKSPACE_DIR" config user.email "${BOT_ID}+${BOT_LOGIN}@users.noreply.github.com"
    echo "Git identity configured for $WORKSPACE_DIR: $BOT_LOGIN <${BOT_ID}+${BOT_LOGIN}@users.noreply.github.com>"
  else
    echo "WARNING: Could not fetch GitHub App bot identity — commits will use system defaults"
  fi
else
  echo "No workspace repo — skipping git identity config."
fi

# ---------------------------------------------------------------------------
# Step 5: Apply firewall
# ---------------------------------------------------------------------------
echo ""
echo ">>> Step 5: Applying firewall..."

cp "$INSTALL_DIR/ami/firewall.sh" /opt/agent/firewall.sh
cp "$INSTALL_DIR/ami/reset-firewall.sh" /opt/agent/reset-firewall.sh
cp "$INSTALL_DIR/ami/allowed-domains.txt" /opt/agent/allowed-domains.txt
chmod +x /opt/agent/firewall.sh /opt/agent/reset-firewall.sh

# Append repo-specific allowed domains if they exist
if [ -n "$REPO_SCRIPTS" ] && [ -f "$REPO_SCRIPTS/allowed-domains.txt" ]; then
  echo "" >> /opt/agent/allowed-domains.txt
  cat "$REPO_SCRIPTS/allowed-domains.txt" >> /opt/agent/allowed-domains.txt
  echo "Appended repo-specific domains from $REPO_SCRIPTS/allowed-domains.txt"
fi

bash /opt/agent/firewall.sh

echo "Firewall active."

# ---------------------------------------------------------------------------
# Step 6: Fix ownership (first pass — so Claude can read/write source)
# ---------------------------------------------------------------------------
echo ""
echo ">>> Step 6: Fixing ownership (first pass)..."

chown -R ubuntu:ubuntu "$WORKSPACE_DIR"
chown -R ubuntu:ubuntu /home/ubuntu

echo "Ownership fixed."

# ---------------------------------------------------------------------------
# Step 6b: Copy agent workflow skills
# ---------------------------------------------------------------------------
echo ""
echo ">>> Step 6b: Installing agent workflow skills..."

mkdir -p /home/ubuntu/.claude/skills
cp -r "$INSTALL_DIR/skills/"* /home/ubuntu/.claude/skills/
chown -R ubuntu:ubuntu /home/ubuntu/.claude/skills

echo "Agent workflow skills installed."

# ---------------------------------------------------------------------------
# Step 6c: Copy preview config (launch.json + preview scripts) into workspace
# ---------------------------------------------------------------------------
echo ""
echo ">>> Step 6c: Copying preview configuration..."

if [ -n "$REPO_SCRIPTS" ] && [ -f "$REPO_SCRIPTS/launch.json" ]; then
  mkdir -p "$WORKSPACE_DIR/.claude"
  cp "$REPO_SCRIPTS/launch.json" "$WORKSPACE_DIR/.claude/launch.json"
  echo "Copied launch.json from $REPO_SCRIPTS/launch.json"
fi

if [ -n "$REPO_SCRIPTS" ] && [ -d "$REPO_SCRIPTS/preview" ]; then
  mkdir -p "$WORKSPACE_DIR/.claude/preview"
  cp -r "$REPO_SCRIPTS/preview/"* "$WORKSPACE_DIR/.claude/preview/"
  chmod +x "$WORKSPACE_DIR/.claude/preview/"*.sh 2>/dev/null || true
  echo "Copied preview scripts from $REPO_SCRIPTS/preview"
fi

# Exclude injected preview files from git (local-only, never committed)
if [ -d "$WORKSPACE_DIR/.git/info" ]; then
  echo ".claude/launch.json" >> "$WORKSPACE_DIR/.git/info/exclude"
  echo ".claude/preview/" >> "$WORKSPACE_DIR/.git/info/exclude"
fi

echo "Preview configuration copied."

# ---------------------------------------------------------------------------
# Step 6d: Copy MCP env file (.claude/.env.local in workspace)
# ---------------------------------------------------------------------------
echo ""
echo ">>> Step 6d: Copying MCP environment file..."

if [ -f "$WORKSPACE_DIR/$ENV_EXAMPLE" ]; then
  ENV_LOCAL_DIR=$(dirname "$WORKSPACE_DIR/$ENV_EXAMPLE")
  ENV_LOCAL_FILE="$ENV_LOCAL_DIR/.env.local"
  cp "$WORKSPACE_DIR/$ENV_EXAMPLE" "$ENV_LOCAL_FILE"
  echo "MCP environment file copied from $ENV_EXAMPLE."
else
  echo "No $ENV_EXAMPLE found in workspace — skipping."
fi

# ---------------------------------------------------------------------------
# Step 7: Run repo-specific pre-agent script
# ---------------------------------------------------------------------------
echo ""
echo ">>> Step 7: Running pre-agent script..."

if [ -n "$REPO_SCRIPTS" ] && [ -f "$REPO_SCRIPTS/pre-agent.sh" ]; then
  echo "Running $REPO_SCRIPTS/pre-agent.sh..."
  bash "$REPO_SCRIPTS/pre-agent.sh"
else
  echo "No pre-agent script — skipping."
fi

# ---------------------------------------------------------------------------
# Step 8: Start agent-service
# ---------------------------------------------------------------------------
echo ""
echo ">>> Step 8: Starting agent-service..."

cp "$INSTALL_DIR/systemd/agent-service.service" /etc/systemd/system/agent-service.service
systemctl daemon-reload
systemctl unmask agent-service 2>/dev/null || true
systemctl start agent-service

echo "agent-service started."

# ---------------------------------------------------------------------------
# Step 9: Run repo-specific post-agent script
# ---------------------------------------------------------------------------
echo ""
echo ">>> Step 9: Running post-agent script..."

if [ -n "$REPO_SCRIPTS" ] && [ -f "$REPO_SCRIPTS/post-agent.sh" ]; then
  echo "Running $REPO_SCRIPTS/post-agent.sh..."
  bash "$REPO_SCRIPTS/post-agent.sh"
else
  echo "No custom post-agent script — running built-in dependency install..."
  cd "$WORKSPACE_DIR"
  if [ -f "pnpm-lock.yaml" ]; then
    echo "Detected pnpm — running pnpm install..."
    pnpm install --frozen-lockfile
  elif [ -f "yarn.lock" ]; then
    echo "Detected yarn — running yarn install..."
    yarn install --frozen-lockfile
  elif [ -f "package-lock.json" ]; then
    echo "Detected npm — running npm ci..."
    npm ci
  elif [ -f "package.json" ]; then
    echo "Detected package.json (no lockfile) — running npm install..."
    npm install
  else
    echo "No Node.js package manager detected — skipping."
  fi
fi

# ---------------------------------------------------------------------------
# Step 10: Fix ownership (second pass — build created root-owned artifacts)
# ---------------------------------------------------------------------------
echo ""
echo ">>> Step 10: Fixing ownership (second pass)..."

chown -R ubuntu:ubuntu "$WORKSPACE_DIR"

echo "Ownership fixed."

# ---------------------------------------------------------------------------
# Step 11: Signal readiness
# ---------------------------------------------------------------------------
echo ""
echo ">>> Step 11: Signaling readiness..."

touch /opt/agent/ready

echo ""
echo "=== Instance init complete at $(date) ==="
echo ""
echo "Verification:"
echo "  1. curl localhost:${PORT}/health — agent-service responding"
echo "  2. iptables -L -n — firewall rules active"
echo "  3. /opt/agent/ready — marker file exists"
