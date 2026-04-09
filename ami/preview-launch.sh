#!/bin/bash
set -euo pipefail

# Generic preview launcher — reads .claude/launch.json from the workspace.
# Called by the Claude agent via the /preview skill after git push or on demand.
#
# 1. Reads launch.json, selects a configuration by name (or default)
# 2. Runs the configured command (runtimeExecutable + runtimeArgs)
# 3. Creates a named Cloudflare tunnel (or falls back to a quick tunnel)
# 4. Outputs the preview URL to stdout
#
# Idempotent — safe to call multiple times. Reuses existing tunnels,
# restarts the preview process if already running for the same config.
#
# Usage: preview-launch.sh [--name <config-name>]
#
# Expects env vars: WORKSPACE_DIR, AGENT_SESSION_ID
# Named tunnel mode requires: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID,
#   CLOUDFLARE_ZONE_ID, PREVIEW_DOMAIN

WORKSPACE_DIR="${WORKSPACE_DIR:-/workspace/app}"
LAUNCH_JSON="${WORKSPACE_DIR}/.claude/launch.json"

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
CONFIG_NAME=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) CONFIG_NAME="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Step 1: Read launch.json and select configuration
# ---------------------------------------------------------------------------
if [ ! -f "$LAUNCH_JSON" ]; then
  echo "ERROR: No .claude/launch.json found at ${LAUNCH_JSON}" >&2
  exit 1
fi

if [ -z "$CONFIG_NAME" ]; then
  # Select config with "default": true, or fall back to the first entry
  CONFIG_NAME=$(jq -r '
    (.configurations[] | select(.default == true) | .name)
    // .configurations[0].name
  ' "$LAUNCH_JSON")
fi

CONFIG=$(jq --arg name "$CONFIG_NAME" \
  '.configurations[] | select(.name == $name)' "$LAUNCH_JSON")

if [ -z "$CONFIG" ] || [ "$CONFIG" = "null" ]; then
  echo "ERROR: Configuration '${CONFIG_NAME}' not found in launch.json" >&2
  echo "Available configurations:" >&2
  jq -r '.configurations[].name' "$LAUNCH_JSON" >&2
  exit 1
fi

PREVIEW_PORT=$(echo "$CONFIG" | jq -r '.port')

# Build the command — support both "program" (relative to .claude/) and "runtimeExecutable"
PROGRAM=$(echo "$CONFIG" | jq -r '.program // empty')
RUNTIME_EXEC=$(echo "$CONFIG" | jq -r '.runtimeExecutable // empty')

if [ -n "$PROGRAM" ]; then
  # program path is relative to .claude/ — resolve to absolute
  PROGRAM_ARGS=$(echo "$CONFIG" | jq -r '(.args // []) | join(" ")')
  PREVIEW_CMD="bash ${WORKSPACE_DIR}/.claude/${PROGRAM}"
  [ -n "$PROGRAM_ARGS" ] && PREVIEW_CMD="${PREVIEW_CMD} ${PROGRAM_ARGS}"
elif [ -n "$RUNTIME_EXEC" ]; then
  RUNTIME_ARGS=$(echo "$CONFIG" | jq -r '(.runtimeArgs // []) | join(" ")')
  PREVIEW_CMD="${RUNTIME_EXEC} ${RUNTIME_ARGS}"
else
  echo "ERROR: Configuration '${CONFIG_NAME}' must have either 'program' or 'runtimeExecutable'" >&2
  exit 1
fi

echo ">>> [preview] Config: ${CONFIG_NAME}" >&2
echo ">>> [preview] Command: ${PREVIEW_CMD}" >&2
echo ">>> [preview] Port: ${PREVIEW_PORT}" >&2

# ---------------------------------------------------------------------------
# Step 2: Run the preview command (kill previous if running)
# ---------------------------------------------------------------------------
PID_FILE="/tmp/preview-${CONFIG_NAME}.pid"

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo ">>> [preview] Killing previous process for '${CONFIG_NAME}' (pid $(cat "$PID_FILE"))..." >&2
  kill "$(cat "$PID_FILE")" 2>/dev/null || true
  sleep 2
fi

echo ">>> [preview] Starting: ${PREVIEW_CMD}" >&2
cd "$WORKSPACE_DIR"
LOG_FILE="/tmp/preview-${CONFIG_NAME}.log"
nohup ${PREVIEW_CMD} > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
echo ">>> [preview] Process started (pid $(cat "$PID_FILE"))" >&2

# Give the process a moment to start listening
sleep 5

# ---------------------------------------------------------------------------
# Step 3: Install cloudflared if not present
# ---------------------------------------------------------------------------
if ! command -v cloudflared &>/dev/null; then
  echo ">>> [preview] Installing cloudflared..." >&2
  curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb \
    -o /tmp/cloudflared.deb
  sudo dpkg -i /tmp/cloudflared.deb >&2
  rm -f /tmp/cloudflared.deb
fi

# ---------------------------------------------------------------------------
# Step 4: Start Cloudflare tunnel
# ---------------------------------------------------------------------------
TUNNEL_PID_FILE="/tmp/cloudflared-${CONFIG_NAME}.pid"
TUNNEL_LOG="/tmp/cloudflared-${CONFIG_NAME}.log"

# Fall back to quick tunnel if named tunnel env vars are missing
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] || [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ] || \
   [ -z "${CLOUDFLARE_ZONE_ID:-}" ] || [ -z "${PREVIEW_DOMAIN:-}" ] || \
   [ -z "${AGENT_SESSION_ID:-}" ]; then
  echo "WARNING: Missing Cloudflare env vars, falling back to quick tunnel." >&2

  if [ -f "$TUNNEL_PID_FILE" ] && kill -0 "$(cat "$TUNNEL_PID_FILE")" 2>/dev/null; then
    echo ">>> [preview] Tunnel already running (pid $(cat "$TUNNEL_PID_FILE"))." >&2
    if [ -f "$TUNNEL_LOG" ]; then
      grep -oEm1 'https://[a-zA-Z0-9._-]+\.trycloudflare\.com' "$TUNNEL_LOG" || true
    fi
    exit 0
  fi

  cloudflared tunnel --url "http://localhost:${PREVIEW_PORT}" \
    --http-host-header "localhost:${PREVIEW_PORT}" \
    > "$TUNNEL_LOG" 2>&1 &
  echo $! > "$TUNNEL_PID_FILE"
  PREVIEW_URL=$(timeout 30 tail -f "$TUNNEL_LOG" 2>/dev/null \
    | grep -oEm1 'https://[a-zA-Z0-9._-]+\.trycloudflare\.com') || true
  if [ -n "$PREVIEW_URL" ]; then
    echo "$PREVIEW_URL"
  else
    echo "WARNING: Quick tunnel started but no URL found within 30s." >&2
    cat "$TUNNEL_LOG" >&2 2>/dev/null || true
  fi
  exit 0
fi

# --- Named tunnel mode ---

SHORT_ID="${AGENT_SESSION_ID:0:8}"
TUNNEL_NAME="preview-${SHORT_ID}-${CONFIG_NAME}"
HOSTNAME="${TUNNEL_NAME}.${PREVIEW_DOMAIN}"

# If tunnel already running, just output URL
if [ -f "$TUNNEL_PID_FILE" ] && kill -0 "$(cat "$TUNNEL_PID_FILE")" 2>/dev/null; then
  echo ">>> [preview] Tunnel already running for '${CONFIG_NAME}' (pid $(cat "$TUNNEL_PID_FILE"))." >&2
  echo "https://${HOSTNAME}"
  exit 0
fi

echo ">>> [preview] Creating named Cloudflare tunnel '${TUNNEL_NAME}'..." >&2

# Create tunnel via Cloudflare API
TUNNEL_SECRET=$(openssl rand -base64 32)
TUNNEL_RESP=$(curl -s --connect-timeout 10 -X POST \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"${TUNNEL_NAME}\",\"tunnel_secret\":\"${TUNNEL_SECRET}\"}")

TUNNEL_ID=$(echo "$TUNNEL_RESP" | jq -r '.result.id')
TUNNEL_TOKEN=$(echo "$TUNNEL_RESP" | jq -r '.result.token')

if [ -z "$TUNNEL_ID" ] || [ "$TUNNEL_ID" = "null" ]; then
  echo "ERROR: Failed to create tunnel" >&2
  echo "$TUNNEL_RESP" >&2
  exit 1
fi

echo ">>> [preview] Tunnel created: ${TUNNEL_ID}" >&2

# Add DNS CNAME: preview-{short-id}-{name}.{domain} → {tunnel-uuid}.cfargotunnel.com
echo ">>> [preview] Adding DNS CNAME: ${HOSTNAME} → ${TUNNEL_ID}.cfargotunnel.com" >&2
DNS_RESP=$(curl -s --connect-timeout 10 -X POST \
  "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"CNAME\",\"name\":\"${HOSTNAME}\",\"content\":\"${TUNNEL_ID}.cfargotunnel.com\",\"proxied\":true}")

DNS_SUCCESS=$(echo "$DNS_RESP" | jq -r '.success')
if [ "$DNS_SUCCESS" != "true" ]; then
  echo "WARNING: DNS record creation may have failed:" >&2
  echo "$DNS_RESP" >&2
fi

# Run tunnel with --protocol http2 to avoid QUIC issues in VPC
echo ">>> [preview] Starting cloudflared tunnel run..." >&2
cloudflared tunnel run --token "$TUNNEL_TOKEN" \
  --url "http://localhost:${PREVIEW_PORT}" \
  --http-host-header "localhost:${PREVIEW_PORT}" \
  --protocol http2 \
  > "$TUNNEL_LOG" 2>&1 &
echo $! > "$TUNNEL_PID_FILE"

# Give tunnel a moment to connect
sleep 5

echo ">>> [preview] Preview URL: https://${HOSTNAME}" >&2
echo "https://${HOSTNAME}"
echo ">>> [preview] Done." >&2
