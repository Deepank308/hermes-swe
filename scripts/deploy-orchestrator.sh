#!/bin/bash
set -euo pipefail

# Deploy updates to the orchestrator.
# Usage (from local machine): bash scripts/deploy-orchestrator.sh <host>
# Usage (on server):          bash scripts/deploy-orchestrator.sh
#
# Examples:
#   bash scripts/deploy-orchestrator.sh orchestrator.yourdomain.com
#   bash scripts/deploy-orchestrator.sh ubuntu@1.2.3.4
#   ssh ubuntu@host 'bash /opt/orchestrator/scripts/deploy-orchestrator.sh'

INSTALL_DIR="/opt/agent/hermes-swe"

# --- Remote mode: SSH into host and run this script there ---
if [ "${1:-}" != "" ] && [ "${1:-}" != "--local" ]; then
  HOST="$1"
  # Add ubuntu@ if no user specified
  [[ "$HOST" == *@* ]] || HOST="ubuntu@$HOST"
  # Detect current local branch and pass to remote
  LOCAL_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")"
  echo ">>> Deploying branch '${LOCAL_BRANCH}' to ${HOST}..."
  ssh "$HOST" "bash ${INSTALL_DIR}/scripts/deploy-orchestrator.sh --local ${LOCAL_BRANCH}"
  echo ">>> Done!"
  exit 0
fi

# Branch argument (passed from remote mode or manual invocation)
DEPLOY_BRANCH="${2:-main}"

# --- Local mode: run on the server itself ---
echo "=== Deploying Orchestrator (branch: ${DEPLOY_BRANCH}) ==="

cd "$INSTALL_DIR"

echo ">>> Pulling latest code..."
git fetch origin
if [ "$DEPLOY_BRANCH" != "main" ]; then
  echo ">>> Checking out branch: ${DEPLOY_BRANCH}"
  git checkout "$DEPLOY_BRANCH" 2>/dev/null || git checkout -b "$DEPLOY_BRANCH" "origin/$DEPLOY_BRANCH"
fi
git pull --ff-only

# Write AGENT_INFRA_BRANCH to /opt/agent/env so orchestrator passes it to agents
if [ -f /opt/agent/env ]; then
  sed -i '/^AGENT_INFRA_BRANCH=/d' /opt/agent/env
  if [ "$DEPLOY_BRANCH" != "main" ]; then
    echo "AGENT_INFRA_BRANCH=$DEPLOY_BRANCH" >> /opt/agent/env
    echo ">>> Set AGENT_INFRA_BRANCH=$DEPLOY_BRANCH in /opt/agent/env"
  else
    echo ">>> Cleared AGENT_INFRA_BRANCH from /opt/agent/env (using main)"
  fi
fi

echo ">>> Installing dependencies..."
pnpm install --frozen-lockfile --filter orchestrator

echo ">>> Building orchestrator..."
NODE_OPTIONS="--max-old-space-size=512" pnpm --filter orchestrator build

echo ">>> Restarting service..."
sudo systemctl restart orchestrator

# Wait for health check (orchestrator loads secrets + session state at startup)
echo ">>> Waiting for health check..."
for i in $(seq 1 15); do
  if curl -sf http://localhost:${PORT:-3001}/health >/dev/null 2>&1; then
    echo ">>> Orchestrator healthy after ${i}s"
    curl -s http://localhost:${PORT:-3001}/health
    echo ""
    break
  fi
  if [ "$i" -eq 15 ]; then
    echo ">>> ERROR: Health check failed after 15s"
    journalctl -u orchestrator --no-pager -n 30
    exit 1
  fi
  sleep 1
done
