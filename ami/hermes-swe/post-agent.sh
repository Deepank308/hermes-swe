#!/bin/bash
set -euo pipefail

# ai-agent-infra post-agent script — runs after agent-service starts
# Auto-detects package manager and installs dependencies
#
# Expects: WORKSPACE_DIR set by caller

WORKSPACE_DIR="${WORKSPACE_DIR:-/workspace/ai-agent-infra}"

echo ">>> [ai-agent-infra] Installing dependencies..."

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
  echo "No Node.js package manager detected — skipping install."
fi

echo ">>> [ai-agent-infra] Post-agent setup complete."
