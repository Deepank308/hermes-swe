#!/bin/bash
set -euo pipefail

# Automated AMI baking script — run from the orchestrator.
# Launches a temporary EC2 instance, runs setup + prepare-ami, creates an AMI,
# waits for it to be available, then terminates the bake instance.
#
# Usage: bash scripts/bake-ami.sh [--repo org/repo]
#
# Options:
#   --repo org/repo   Repository to bake (e.g. your-org/your-app).
#                     Reads config from repos.json. Defaults to repos.json default.
#
# Prerequisites:
#   - GITHUB_TOKEN set in environment (or in /opt/agent/env)
#   - SSH key available at ~/.ssh/hermes-key.pem (or set SSH_KEY_PATH)
#   - AWS CLI configured with permissions to run instances and create images
#   - Bake security group (hermes-bake-sg) exists with SSH open

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Source orchestrator env first (for GITHUB_TOKEN) — before aws-config.sh
# so repos.json overrides take precedence over env file values.
[ -f /opt/agent/env ] && { set -a; source /opt/agent/env; set +a; }

source "$SCRIPT_DIR/aws-config.sh"
REGION="$AWS_REGION"

# Parse arguments
REPO=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --repo)
      REPO="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: bash scripts/bake-ami.sh [--repo org/repo]"
      exit 1
      ;;
  esac
done

# Resolve repo config from repos.json
REPOS_JSON="$ROOT_DIR/repos.json"
if [ -n "$REPO" ]; then
  # Specific repo — must exist in repos.json
  REPO_CONFIG=$(jq -r --arg repo "$REPO" '.[$repo] // empty' "$REPOS_JSON")
  if [ -z "$REPO_CONFIG" ]; then
    echo "ERROR: Repo '$REPO' not found in repos.json"
    echo "  Available repos: $(jq -r 'keys | join(", ")' "$REPOS_JSON")"
    exit 1
  fi
  REPO_AMI=$(echo "$REPO_CONFIG" | jq -r '.amiName')
  SCRIPTS_DIR=$(echo "$REPO_CONFIG" | jq -r '.scriptsDir // empty')
  BAKE_AMI=$(echo "$REPO_CONFIG" | jq -r '.bakeAmi // false')
  if [ "$BAKE_AMI" != "true" ]; then
    echo "ERROR: bakeAmi is false for $REPO — this repo uses a shared AMI"
    echo "  To bake the shared default AMI, run without --repo"
    exit 1
  fi
  INSTANCE_TYPE_OVERRIDE=$(echo "$REPO_CONFIG" | jq -r '.instanceType // empty')
  if [ -n "$INSTANCE_TYPE_OVERRIDE" ]; then
    AGENT_INSTANCE_TYPE="$INSTANCE_TYPE_OVERRIDE"
  fi
else
  # Generic AMI bake (no --repo)
  REPO_AMI="default"
  SCRIPTS_DIR=""
fi

SSH_KEY_PATH="${SSH_KEY_PATH:-$HOME/.ssh/hermes-key.pem}"
SSH_OPTS="-i $SSH_KEY_PATH -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o LogLevel=ERROR"

if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "ERROR: GITHUB_TOKEN must be set"
  exit 1
fi

if [ ! -f "$SSH_KEY_PATH" ]; then
  echo "ERROR: SSH key not found at $SSH_KEY_PATH"
  echo "  Set SSH_KEY_PATH to the correct path"
  exit 1
fi

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

# ---------------------------------------------------------------------------
# Step 1: Resolve resources
# ---------------------------------------------------------------------------
echo "=== AMI Bake ==="
echo "Region: $REGION"
echo "Repo: ${REPO:-NULL}"
echo "Repo AMI: $REPO_AMI"
echo "Instance type: $AGENT_INSTANCE_TYPE"
echo ""

echo "Scripts dir: ${SCRIPTS_DIR:-none}"
echo ""

echo ">>> Resolving resources..."

# Bake security group
BAKE_SG_ID=$(aws ec2 describe-security-groups \
  --group-names "$AGENT_BAKE_SG_NAME" \
  --query 'SecurityGroups[0].GroupId' \
  --output text \
  --region "$REGION" 2>/dev/null || echo "")
[ "$BAKE_SG_ID" = "None" ] && BAKE_SG_ID=""

if [ -z "$BAKE_SG_ID" ]; then
  echo "ERROR: Bake security group '$AGENT_BAKE_SG_NAME' not found"
  exit 1
fi
echo "  Bake SG: $BAKE_SG_ID"

# Subnet — use the same subnet as the orchestrator
SUBNET_ID=$(imds_get "network/interfaces/macs/$(imds_get 'mac')/subnet-id")
if [ -z "$SUBNET_ID" ]; then
  echo "ERROR: Could not determine subnet from instance metadata"
  exit 1
fi
echo "  Subnet: $SUBNET_ID (same as orchestrator)"

# Base AMI
BASE_AMI_ID=$(aws ec2 describe-images \
  --owners 099720109477 \
  --region "$REGION" \
  --filters \
    "Name=name,Values=ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*" \
    "Name=architecture,Values=x86_64" \
    "Name=state,Values=available" \
  --query 'Images | sort_by(@, &CreationDate) | [-1].ImageId' \
  --output text 2>/dev/null || echo "None")
if [ -z "$BASE_AMI_ID" ] || [ "$BASE_AMI_ID" = "None" ]; then
  echo "ERROR: Could not find Ubuntu 22.04 amd64 base AMI"
  exit 1
fi
echo "  Base AMI: $BASE_AMI_ID"

# Key pair
KEY_ARGS=""
if aws ec2 describe-key-pairs --key-names "$KEY_PAIR_NAME" --region "$REGION" >/dev/null 2>&1; then
  KEY_ARGS="--key-name $KEY_PAIR_NAME"
  echo "  Key pair: $KEY_PAIR_NAME"
else
  echo "ERROR: Key pair '$KEY_PAIR_NAME' not found"
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 2: Launch bake instance
# ---------------------------------------------------------------------------
echo ""
echo ">>> Launching bake instance..."

INSTANCE_ID=$(aws ec2 run-instances \
  --region "$REGION" \
  --image-id "$BASE_AMI_ID" \
  --instance-type "$AGENT_INSTANCE_TYPE" \
  --subnet-id "$SUBNET_ID" \
  --security-group-ids "$BAKE_SG_ID" \
  --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":100,"VolumeType":"gp3"}}]' \
  --associate-public-ip-address \
  $KEY_ARGS \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=hermes-ami-bake-${REPO_AMI}},{Key=Project,Value=hermes}]" \
  --query 'Instances[0].InstanceId' --output text)

echo "  Instance: $INSTANCE_ID"
echo "  Waiting for running state..."

aws ec2 wait instance-running --instance-ids "$INSTANCE_ID" --region "$REGION"

PUBLIC_IP=$(aws ec2 describe-instances \
  --instance-ids "$INSTANCE_ID" \
  --region "$REGION" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' \
  --output text)

echo "  Public IP: $PUBLIC_IP"

# ---------------------------------------------------------------------------
# Step 3: Wait for SSH
# ---------------------------------------------------------------------------
echo ""
echo ">>> Waiting for SSH..."

for i in $(seq 1 30); do
  if ssh $SSH_OPTS ubuntu@"$PUBLIC_IP" "echo ok" >/dev/null 2>&1; then
    echo "  SSH ready after ${i} attempts"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "ERROR: SSH not available after 30 attempts"
    echo "  Terminating instance $INSTANCE_ID"
    aws ec2 terminate-instances --instance-ids "$INSTANCE_ID" --region "$REGION" >/dev/null
    exit 1
  fi
  sleep 10
done

# ---------------------------------------------------------------------------
# Step 4: Run setup.sh (base deps)
# ---------------------------------------------------------------------------
echo ""
echo ">>> Running setup.sh..."

ssh $SSH_OPTS ubuntu@"$PUBLIC_IP" 'sudo bash -s' < "$ROOT_DIR/ami/setup.sh"

echo "  Setup complete."

# ---------------------------------------------------------------------------
# Step 4b: Run repo-specific setup.sh (extra deps like Yarn, Docker pulls)
# ---------------------------------------------------------------------------
REPO_SETUP=""
if [ -n "$SCRIPTS_DIR" ]; then
  REPO_SETUP="$ROOT_DIR/$SCRIPTS_DIR/setup.sh"
fi
if [ -n "$REPO_SETUP" ] && [ -f "$REPO_SETUP" ]; then
  echo ""
  echo ">>> Running repo-specific setup ($SCRIPTS_DIR)..."

  ssh $SSH_OPTS ubuntu@"$PUBLIC_IP" 'sudo bash -s' < "$REPO_SETUP"

  echo "  Repo-specific setup complete."
fi

# ---------------------------------------------------------------------------
# Step 5: Run prepare-ami.sh (clones ai-agent-infra, reads repos.json, delegates)
# ---------------------------------------------------------------------------
echo ""
echo ">>> Running prepare-ami.sh..."

ssh $SSH_OPTS ubuntu@"$PUBLIC_IP" "GITHUB_TOKEN=$GITHUB_TOKEN sudo -E bash -s -- $REPO" < "$ROOT_DIR/ami/prepare-ami.sh"

echo "  Prepare-ami complete."

# ---------------------------------------------------------------------------
# Step 6: Create AMI
# ---------------------------------------------------------------------------
echo ""
echo ">>> Creating AMI..."

# Flush filesystem buffers — --no-reboot skips shutdown so unflushed writes
# get snapshotted as truncated files (e.g. .git/index corruption).
ssh $SSH_OPTS ubuntu@"$PUBLIC_IP" "sudo sync"

AMI_NAME="hermes-agent-${REPO_AMI}-$(date +%Y-%m-%d-%H%M)"
AMI_ID=$(aws ec2 create-image \
  --instance-id "$INSTANCE_ID" \
  --name "$AMI_NAME" \
  --region "$REGION" \
  --no-reboot \
  --tag-specifications "ResourceType=image,Tags=[{Key=Name,Value=$AMI_NAME},{Key=Project,Value=hermes}]" "ResourceType=snapshot,Tags=[{Key=Name,Value=$AMI_NAME},{Key=Project,Value=hermes}]" \
  --query 'ImageId' --output text)

echo "  AMI: $AMI_ID ($AMI_NAME)"

# ---------------------------------------------------------------------------
# Step 7: Update orchestrator env (before waiting — AMI ID is already known)
# ---------------------------------------------------------------------------
AMI_ENV_VAR="AGENT_AMI_ID_$(echo "$REPO_AMI" | tr '[:lower:]' '[:upper:]')"

if [ -f /opt/agent/env ]; then
  if grep -q "^${AMI_ENV_VAR}=" /opt/agent/env; then
    OLD_AMI=$(grep "^${AMI_ENV_VAR}=" /opt/agent/env | cut -d= -f2)
    sed -i "s/^${AMI_ENV_VAR}=.*/${AMI_ENV_VAR}=$AMI_ID/" /opt/agent/env
    echo "  Updated ${AMI_ENV_VAR} in /opt/agent/env: $OLD_AMI → $AMI_ID"
  else
    echo "${AMI_ENV_VAR}=$AMI_ID" >> /opt/agent/env
    echo "  Added ${AMI_ENV_VAR} to /opt/agent/env"
  fi
else
  echo "  WARNING: /opt/agent/env not found — set manually:"
  echo "    echo '${AMI_ENV_VAR}=$AMI_ID' >> /opt/agent/env"
fi

# ---------------------------------------------------------------------------
# Step 8: Wait for AMI + terminate bake instance
# ---------------------------------------------------------------------------
echo ""
echo "  Waiting for AMI to be available (this can take several minutes)..."

aws ec2 wait image-available --image-ids "$AMI_ID" --region "$REGION" || \
  echo "  WARNING: AMI wait timed out — AMI may still be pending. Check: aws ec2 describe-images --image-ids $AMI_ID"

echo ""
echo ">>> Terminating bake instance..."

aws ec2 terminate-instances --instance-ids "$INSTANCE_ID" --region "$REGION" >/dev/null

echo "  Terminated: $INSTANCE_ID"

# ---------------------------------------------------------------------------
echo ""
echo "=== AMI bake complete ==="
echo ""
echo "  AMI ID: $AMI_ID"
echo "  AMI Name: $AMI_NAME"
echo ""
echo "  Restart orchestrator to pick up the new AMI:"
echo "    sudo systemctl restart orchestrator"
