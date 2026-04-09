#!/bin/bash
set -euo pipefail

# Setup for the orchestrator on a new Ubuntu EC2 instance (t4g.nano/ARM or x86).
# Called by scripts/setup.sh, or run standalone:
#   ssh ubuntu@<ip> "GITHUB_TOKEN=xxx CLOUDFLARE_HOSTNAME=hermes.example.com bash -s" < scripts/setup-orchestrator.sh
#
# After running:
#   1. Deploy: bash /opt/agent/hermes-swe/scripts/deploy-orchestrator.sh
#   2. Visit /oauth/install to connect Linear

GITHUB_TOKEN="${GITHUB_TOKEN:-}"
if [ -n "$GITHUB_TOKEN" ]; then
  REPO_URL="${REPO_URL:-https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO_ORG:-your-org}/hermes-swe.git}"
else
  REPO_URL="${REPO_URL:-git@github.com:${REPO_ORG:-your-org}/hermes-swe.git}"
fi
CLOUDFLARE_TUNNEL_NAME="${CLOUDFLARE_TUNNEL_NAME:-hermes-ec2}"
CLOUDFLARE_HOSTNAME="${CLOUDFLARE_HOSTNAME:-hermes.yourdomain.com}"
INSTALL_DIR="/opt/agent/hermes-swe"
NODE_MAJOR=24

echo "=== Orchestrator Fresh Setup ==="

# --- Helper: set a variable in /opt/agent/env ---
set_env() {
  local key="$1" value="$2"
  if grep -q "^${key}=" /opt/agent/env 2>/dev/null; then
    sudo sed -i "s|^${key}=.*|${key}=${value}|" /opt/agent/env
  else
    echo "${key}=${value}" | sudo tee -a /opt/agent/env > /dev/null
  fi
  echo "  ${key}=${value}"
}

# --- Swap (t4g.nano has only 512MB RAM — pnpm needs more) ---
if [ ! -f /swapfile ]; then
  echo ">>> Creating 1GB swap..."
  sudo fallocate -l 1G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab > /dev/null
  echo "  Swap active: $(swapon --show --noheadings)"
else
  sudo swapon /swapfile 2>/dev/null || true
  echo ">>> Swap already configured"
fi

# --- System packages ---
echo ">>> Updating system packages..."
sudo apt-get update -y
sudo apt-get upgrade -y
sudo apt-get install -y curl git jq unzip

# --- AWS CLI ---
echo ">>> Installing AWS CLI..."
if ! command -v aws &>/dev/null; then
  ARCH=$(uname -m)
  if [ "$ARCH" = "aarch64" ]; then
    curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o /tmp/awscliv2.zip
  else
    curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
  fi
  unzip -q /tmp/awscliv2.zip -d /tmp
  sudo /tmp/aws/install
  rm -rf /tmp/aws /tmp/awscliv2.zip
fi
echo "  AWS CLI: $(aws --version)"

# --- Node.js ---
echo ">>> Installing Node.js ${NODE_MAJOR}..."
if ! command -v node &>/dev/null || ! node -v | grep -q "v${NODE_MAJOR}"; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "  Node: $(node -v)"

# --- pnpm ---
echo ">>> Installing pnpm..."
if ! command -v pnpm &>/dev/null; then
  sudo npm install -g pnpm
fi
echo "  pnpm: $(pnpm -v)"

# --- Cloudflare Tunnel ---
echo ">>> Installing cloudflared..."
if ! command -v cloudflared &>/dev/null; then
  ARCH=$(uname -m)
  if [ "$ARCH" = "aarch64" ]; then
    curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb -o /tmp/cloudflared.deb
  else
    curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cloudflared.deb
  fi
  sudo dpkg -i /tmp/cloudflared.deb
  rm -f /tmp/cloudflared.deb
fi
echo "  cloudflared: $(cloudflared version 2>&1 | head -1)"

# --- Clone repo ---
echo ">>> Cloning repository..."
if [ -d "$INSTALL_DIR" ]; then
  echo "  $INSTALL_DIR already exists, pulling latest..."
  cd "$INSTALL_DIR"
  git pull
else
  sudo mkdir -p "$(dirname "$INSTALL_DIR")"
  sudo chown ubuntu:ubuntu "$(dirname "$INSTALL_DIR")"
  git clone "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# --- Source shared config ---
source "$INSTALL_DIR/scripts/aws-config.sh"

# --- Cloudflare Tunnel ---
echo ">>> Setting up Cloudflare Tunnel..."
TUNNEL_URL=""
if [ -z "${CLOUDFLARE_HOSTNAME:-}" ]; then
  echo "  WARNING: CLOUDFLARE_HOSTNAME not set, skipping tunnel setup."
  echo "  Set CLOUDFLARE_HOSTNAME and re-run, or configure manually."
else
  echo ""
  echo "  A browser URL will appear below. Open it to authorize Cloudflare."
  echo "  If running over SSH, copy the URL and open it on your local machine."
  echo ""

  # Login (interactive — user clicks URL to authorize)
  cloudflared tunnel login

  # Create tunnel (idempotent — fails gracefully if name exists)
  cloudflared tunnel create "${CLOUDFLARE_TUNNEL_NAME}" 2>/dev/null || echo "  Tunnel '${CLOUDFLARE_TUNNEL_NAME}' may already exist, continuing..."

  # Route DNS
  cloudflared tunnel route dns "${CLOUDFLARE_TUNNEL_NAME}" "${CLOUDFLARE_HOSTNAME}" 2>/dev/null || echo "  DNS route may already exist, continuing..."

  # Locate credentials file
  CRED_FILE=$(ls ~/.cloudflared/*.json 2>/dev/null | grep -v cert | head -1 || true)
  if [ -z "$CRED_FILE" ]; then
    echo "  ERROR: No tunnel credentials found after creation"
  else
    # Copy credentials to system location
    sudo mkdir -p /etc/cloudflared
    sudo cp "$CRED_FILE" /etc/cloudflared/
    sudo cp ~/.cloudflared/cert.pem /etc/cloudflared/ 2>/dev/null || true
    CRED_PATH="/etc/cloudflared/$(basename "$CRED_FILE")"

    # Write config
    sudo tee /etc/cloudflared/config.yml > /dev/null <<CFEOF
tunnel: ${CLOUDFLARE_TUNNEL_NAME}
credentials-file: ${CRED_PATH}

ingress:
  - hostname: ${CLOUDFLARE_HOSTNAME}
    service: http://localhost:${ORCH_PORT}
  - service: http_status:404
CFEOF

    # Install and start as systemd service
    sudo cloudflared service install 2>/dev/null || true
    sudo systemctl enable cloudflared
    sudo systemctl restart cloudflared

    TUNNEL_URL="https://${CLOUDFLARE_HOSTNAME}"
    echo "  Tunnel active: ${TUNNEL_URL}"
  fi
fi

# --- systemd service ---
echo ">>> Installing orchestrator systemd service..."
sudo cp "$INSTALL_DIR/systemd/orchestrator.service" /etc/systemd/system/orchestrator.service
sudo systemctl daemon-reload
sudo systemctl enable orchestrator

# --- Create env file from .env.example ---
sudo mkdir -p /opt/agent
if [ -f /opt/agent/env ]; then
  echo ">>> Found /opt/agent/env, keeping existing"
else
  echo ">>> Creating /opt/agent/env from .env.example..."
  sudo cp "$INSTALL_DIR/orchestrator/.env.example" /opt/agent/env
  # Override DRY_RUN to false for production
  sudo sed -i 's/^DRY_RUN=true/DRY_RUN=false/' /opt/agent/env
  sudo chmod 600 /opt/agent/env
  sudo chown ubuntu:ubuntu /opt/agent/env
fi

# --- Detect runtime values ---
echo ">>> Detecting environment values..."

# Instance metadata (IMDSv2 with IMDSv1 fallback)
IMDS_TOKEN=$(curl -sf -X PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 60" 2>/dev/null || echo "")
imds_get() {
  local path="$1"
  if [ -n "$IMDS_TOKEN" ]; then
    curl -sf -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" "http://169.254.169.254/latest/meta-data/${path}" 2>/dev/null || echo ""
  else
    curl -sf "http://169.254.169.254/latest/meta-data/${path}" 2>/dev/null || echo ""
  fi
}

PRIVATE_IP=$(imds_get "local-ipv4")
REGION=$(imds_get "placement/region")
SUBNET_ID=$(imds_get "network/interfaces/macs/$(imds_get 'mac')/subnet-id")

# AWS API lookups (require region)
AGENT_SG_ID=""
KEY_NAME=""
if [ -n "$REGION" ]; then
  echo "  Looking up resources in $REGION (SG=$AGENT_SG_NAME, Key=$KEY_PAIR_NAME)..."

  AGENT_SG_ID=$(aws ec2 describe-security-groups \
    --group-names "$AGENT_SG_NAME" \
    --query 'SecurityGroups[0].GroupId' \
    --output text \
    --region "$REGION" 2>&1 || true)
  if [ -z "$AGENT_SG_ID" ] || [ "$AGENT_SG_ID" = "None" ] || [[ "$AGENT_SG_ID" == *"error"* ]] || [[ "$AGENT_SG_ID" == *"Error"* ]]; then
    echo "  WARNING: Could not find SG '$AGENT_SG_NAME': ${AGENT_SG_ID:-empty}"
    AGENT_SG_ID=""
  fi

  if aws ec2 describe-key-pairs --key-names "$KEY_PAIR_NAME" --region "$REGION" >/dev/null 2>&1; then
    KEY_NAME="$KEY_PAIR_NAME"
  fi

  REPOS_JSON="$INSTALL_DIR/repos.json"
fi

# --- Write all env vars ---
echo ">>> Writing environment variables..."

# Constants from aws-config.sh
set_env "SESSIONS_BUCKET" "$BUCKET_NAME"
set_env "SECRET_NAME" "$SECRET_NAME"
set_env "SESSIONS_KEY" "$SESSIONS_KEY"
set_env "AGENT_INSTANCE_TYPE" "$AGENT_INSTANCE_TYPE"
set_env "SNAPSHOT_RETENTION_DAYS" "$SNAPSHOT_RETENTION_DAYS"

# Detected from instance metadata
[ -n "$PRIVATE_IP" ] && set_env "CALLBACK_BASE_URL" "http://${PRIVATE_IP}:${ORCH_INTERNAL_PORT}"
[ -n "${TUNNEL_URL:-}" ] && set_env "LINEAR_REDIRECT_URI" "${TUNNEL_URL}/oauth/callback"
[ -n "$REGION" ]     && set_env "AWS_REGION" "$REGION"
[ -n "$SUBNET_ID" ]  && set_env "SUBNET_ID" "$SUBNET_ID"

# Detected from AWS API
[ -n "$AGENT_SG_ID" ]    && set_env "AGENT_SECURITY_GROUP_ID" "$AGENT_SG_ID"
[ -n "$KEY_NAME" ]       && set_env "KEY_NAME" "$KEY_NAME"

# Per-repo AMI IDs (from repos.json)
if [ -n "${REPOS_JSON:-}" ] && [ -f "$REPOS_JSON" ]; then
  for REPO_KEY in $(jq -r 'keys[]' "$REPOS_JSON"); do
    REPO_NAME=$(jq -r --arg k "$REPO_KEY" '.[$k].amiName' "$REPOS_JSON")
    AMI_ENV_VAR="AGENT_AMI_ID_$(echo "$REPO_NAME" | tr '[:lower:]' '[:upper:]')"

    REPO_AMI_ID=$(aws ec2 describe-images \
      --owners self --region "$REGION" \
      --filters "Name=name,Values=${AMI_NAME_PREFIX}-${REPO_NAME}-*" \
      --query 'Images | sort_by(@, &CreationDate) | [-1].ImageId' \
      --output text 2>&1 || true)

    if [ -n "$REPO_AMI_ID" ] && [ "$REPO_AMI_ID" != "None" ] && [[ "$REPO_AMI_ID" != *"error"* ]] && [[ "$REPO_AMI_ID" != *"Error"* ]]; then
      set_env "$AMI_ENV_VAR" "$REPO_AMI_ID"
    else
      echo "  WARNING: No AMI found for ${REPO_NAME} (pattern: ${AMI_NAME_PREFIX}-${REPO_NAME}-*)"
    fi
  done
fi

# --- Done ---
echo ""
echo "==========================================="
echo "Setup complete!"
echo "==========================================="
echo ""
echo "Environment file: /opt/agent/env"
echo ""

# Show what's set and what's missing
echo "--- Current env ---"
cat /opt/agent/env 2>/dev/null || true
echo ""

MISSING=""
for var in CALLBACK_BASE_URL LINEAR_REDIRECT_URI AWS_REGION SESSIONS_BUCKET SECRET_NAME SESSIONS_KEY SUBNET_ID AGENT_SECURITY_GROUP_ID AGENT_INSTANCE_TYPE; do
  if ! grep -q "^${var}=" /opt/agent/env 2>/dev/null; then
    MISSING="${MISSING}  ${var}\n"
  fi
done

if [ -n "$MISSING" ]; then
  echo "--- Still need to set manually ---"
  echo -e "$MISSING"
fi

echo "--- Next steps ---"
echo "  1. Deploy: bash ${INSTALL_DIR}/scripts/deploy-orchestrator.sh"
if [ -n "${TUNNEL_URL:-}" ]; then
  echo "  2. Visit: ${TUNNEL_URL}/oauth/install to connect Linear"
fi
