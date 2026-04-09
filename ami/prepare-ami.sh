#!/bin/bash
set -euo pipefail
IFS=$'\n\t'

# AMI preparation script — run on an EC2 instance AFTER setup.sh
# Generic: installs agent-service, firewall, directory structure, systemd.
# Delegates repo-specific steps (clone, build, Docker) to ami/<name>/prepare.sh.
#
# Usage: prepare-ami.sh [repo]
#   repo — org/repo (e.g. "your-org/your-app"), defaults to REPO env
#
# This script is piped via SSH by bake-ami.sh, so BASH_SOURCE won't resolve.
# It clones ai-agent-infra first, then reads repos.json and repo scripts from disk.

INSTALL_DIR="/opt/agent/hermes-swe"

REPO="${1:-${REPO:-}}"

echo "=== AI Agent - AMI Preparation ==="
echo "Repo: ${REPO:-NULL}"
echo "Starting at $(date)"

# ---------------------------------------------------------------------------
# Step 1: Clone ai-agent-infra (needed for repos.json, firewall, systemd, repo scripts)
# ---------------------------------------------------------------------------
echo ""
echo ">>> Step 1: Installing agent-infra..."

mkdir -p /opt/agent
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "Agent-infra repo already exists, pulling latest..."
  cd "$INSTALL_DIR"
  gh repo sync --force
else
  gh repo clone "${AGENT_INFRA_REPO:-hermes-swe}" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi
pnpm install --filter agent-service --frozen-lockfile
pnpm --filter agent-service build

echo "Agent-infra installed and built."

# ---------------------------------------------------------------------------
# Resolve repo config from repos.json (now available on disk)
# ---------------------------------------------------------------------------
REPOS_JSON="$INSTALL_DIR/repos.json"

if [ -n "$REPO" ] && [ -f "$REPOS_JSON" ]; then
  REPO_CONFIG=$(jq -r --arg repo "$REPO" '.[$repo] // empty' "$REPOS_JSON")
  if [ -z "$REPO_CONFIG" ]; then
    echo "ERROR: Repo '$REPO' not found in repos.json"
    exit 1
  fi
  REPO_AMI=$(echo "$REPO_CONFIG" | jq -r '.amiName')
  SCRIPTS_DIR=$(echo "$REPO_CONFIG" | jq -r '.scriptsDir // empty')
  WORKSPACE_DIR=$(echo "$REPO_CONFIG" | jq -r '.workspaceDir')
else
  # Generic AMI bake (no repo specified)
  REPO_AMI="default"
  SCRIPTS_DIR=""
  WORKSPACE_DIR="/workspace/repo"
fi

echo "Repo AMI: $REPO_AMI"
echo "Scripts dir: ${SCRIPTS_DIR:-none}"
echo "Workspace: $WORKSPACE_DIR"

# ---------------------------------------------------------------------------
# Step 2: Clone target repo
# ---------------------------------------------------------------------------
echo ""
echo ">>> Step 2: Cloning repo..."

if [ -n "$REPO" ]; then
  mkdir -p "$(dirname "$WORKSPACE_DIR")"
  if [ -d "$WORKSPACE_DIR/.git" ]; then
    echo "Repo already exists, pulling latest..."
    cd "$WORKSPACE_DIR"
    gh repo sync --force
  else
    gh repo clone "$REPO" "$WORKSPACE_DIR"
  fi
  echo "Repo cloned to $WORKSPACE_DIR."
else
  echo "No repo specified — skipping clone."
fi

# ---------------------------------------------------------------------------
# Step 3: Run repo-specific preparation
# ---------------------------------------------------------------------------
echo ""
echo ">>> Step 3: Running repo-specific preparation..."

REPO_PREPARE=""
if [ -n "$SCRIPTS_DIR" ]; then
  REPO_PREPARE="$INSTALL_DIR/$SCRIPTS_DIR/prepare.sh"
fi
if [ -n "$REPO_PREPARE" ] && [ -f "$REPO_PREPARE" ]; then
  echo "Running $REPO_PREPARE..."
  WORKSPACE_DIR="$WORKSPACE_DIR" bash "$REPO_PREPARE"
else
  echo "No repo-specific prepare script found — skipping."
fi

# ---------------------------------------------------------------------------
# Step 4: Install firewall scripts
# ---------------------------------------------------------------------------
echo ""
echo ">>> Step 4: Installing firewall scripts..."

cp "$INSTALL_DIR/ami/firewall.sh" /opt/agent/firewall.sh
cp "$INSTALL_DIR/ami/reset-firewall.sh" /opt/agent/reset-firewall.sh
cp "$INSTALL_DIR/ami/allowed-domains.txt" /opt/agent/allowed-domains.txt
chmod +x /opt/agent/firewall.sh /opt/agent/reset-firewall.sh

echo "Firewall scripts installed at /opt/agent/."

# ---------------------------------------------------------------------------
# Step 5: Create directory structure
# ---------------------------------------------------------------------------
echo ""
echo ">>> Step 5: Creating directory structure..."

mkdir -p /home/ubuntu/.cyrus/logs
mkdir -p /home/ubuntu/.claude/projects
chown -R ubuntu:ubuntu /home/ubuntu
chown -R ubuntu:ubuntu /opt/agent
chown -R ubuntu:ubuntu /workspace

echo "Directory structure created."

# ---------------------------------------------------------------------------
# Step 6: Install systemd service for agent-service
# ---------------------------------------------------------------------------
echo ""
echo ">>> Step 6: Installing systemd service..."

cp "$INSTALL_DIR/systemd/agent-service.service" /etc/systemd/system/agent-service.service
systemctl daemon-reload
systemctl enable agent-service

echo "Systemd service installed and enabled (started by init-instance.sh at boot)."

# ---------------------------------------------------------------------------
# Step 7: Clean up for AMI snapshot
# ---------------------------------------------------------------------------
echo ""
echo ">>> Step 7: Cleaning up for AMI snapshot..."

# Remove secrets from manual testing
rm -f /opt/agent/env /opt/agent/ready
rm -f /home/ubuntu/.claude/.credentials.json

# Reset firewall rules (init-instance.sh re-applies at boot)
bash "$INSTALL_DIR/ami/reset-firewall.sh"

# Clear git config from manual testing
git config --global --unset-all credential.helper 2>/dev/null || true
git config --global --unset-all safe.directory 2>/dev/null || true
sudo -u ubuntu git config --global --unset-all credential.helper 2>/dev/null || true
sudo -u ubuntu git config --global --unset-all safe.directory 2>/dev/null || true

# Stop services
systemctl stop agent-service 2>/dev/null || true

# Clear package manager caches (images/modules are already installed)
apt-get clean
rm -rf /var/lib/apt/lists/*
npm cache clean --force
pnpm store prune

# Clear logs and temp files
rm -rf /tmp/*
rm -rf /var/log/*.gz /var/log/*.1
journalctl --vacuum-time=1s

# Clear user history
rm -f /home/ubuntu/.bash_history /root/.bash_history
history -c

# Clear cloud-init artifacts so it re-runs on new instance
cloud-init clean --logs

# Flush all filesystem buffers to disk before AMI snapshot
sync

echo ""
echo "=== AMI preparation complete at $(date) ==="
echo ""
echo "Verification checklist:"
echo "  1. $WORKSPACE_DIR/ exists with build artifacts (if repo was specified)"
echo "  2. $INSTALL_DIR/agent-service/dist/ exists"
echo "  3. /opt/agent/{firewall,reset-firewall}.sh exist and are executable"
echo "  4. /home/ubuntu/.cyrus/ and /home/ubuntu/.claude/projects/ exist"
echo "  5. systemctl cat agent-service shows the unit file"
echo "Create AMI snapshot:"
echo ""
INSTANCE_ID=$(curl -sf http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null || echo "<INSTANCE_ID>")
REGION=$(curl -sf http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null || echo "<REGION>")
AMI_NAME="hermes-agent-${REPO_AMI}-$(date +%Y-%m-%d)"
echo "  aws ec2 create-image \\"
echo "    --instance-id $INSTANCE_ID \\"
echo "    --name $AMI_NAME \\"
echo "    --region $REGION \\"
echo "    --no-reboot \\"
echo "    --query 'ImageId' --output text"
echo ""
echo "  # Then terminate the bake instance:"
echo "  aws ec2 terminate-instances --instance-ids $INSTANCE_ID --region $REGION"
