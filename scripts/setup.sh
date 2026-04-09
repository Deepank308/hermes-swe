#!/bin/bash
set -euo pipefail

# Unified setup: from zero to running orchestrator.
# Usage: cp .env.example .env.local && <fill in values> && bash scripts/setup.sh
#
# What it does:
#   1. Creates AWS resources (SGs, S3, secrets, IAM, key pair)
#   2. Pushes secrets from .env.local to Secrets Manager
#   3. Launches orchestrator EC2
#   4. SSHes in: installs deps, clones repo, creates Cloudflare tunnel
#   5. Deploys orchestrator (build + start)
#   6. Health check

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ---------------------------------------------------------------------------
# Step 1: Read .env.local
# ---------------------------------------------------------------------------
ENV_FILE="$ROOT_DIR/.env.local"
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: .env.local not found."
  echo ""
  echo "  cp .env.example .env.local"
  echo "  # Fill in the required values, then re-run this script."
  exit 1
fi

# Source .env.local (set -a exports all assignments)
set -a
source "$ENV_FILE"
set +a

# ---------------------------------------------------------------------------
# Step 2: Validate required fields
# ---------------------------------------------------------------------------
echo "=== Hermes Unified Setup ==="
echo ""

MISSING=""
[ -z "${CLOUDFLARE_HOSTNAME:-}" ] && MISSING="${MISSING}  CLOUDFLARE_HOSTNAME\n"
[ -z "${LINEAR_WEBHOOK_SECRET:-}" ] && MISSING="${MISSING}  LINEAR_WEBHOOK_SECRET\n"
[ -z "${LINEAR_CLIENT_ID:-}" ] && MISSING="${MISSING}  LINEAR_CLIENT_ID\n"
[ -z "${LINEAR_CLIENT_SECRET:-}" ] && MISSING="${MISSING}  LINEAR_CLIENT_SECRET\n"
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  MISSING="${MISSING}  CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY\n"
fi

# GITHUB_TOKEN is always required (used to clone repo on the EC2 instance).
# GitHub App credentials are optional (used by orchestrator for short-lived tokens).
[ -z "${GITHUB_TOKEN:-}" ] && MISSING="${MISSING}  GITHUB_TOKEN\n"

HAS_APP=""
if [ -n "${GITHUB_APP_CLIENT_ID:-}" ] && [ -n "${GITHUB_APP_PRIVATE_KEY:-}" ] && [ -n "${GITHUB_APP_INSTALLATION_ID:-}" ]; then
  HAS_APP="yes"
fi

if [ -n "$MISSING" ]; then
  echo "ERROR: Missing required values in .env.local:"
  echo -e "$MISSING"
  exit 1
fi

CLOUDFLARE_TUNNEL_NAME="${CLOUDFLARE_TUNNEL_NAME:-hermes}"

echo "Config:"
echo "  Cloudflare hostname: $CLOUDFLARE_HOSTNAME"
echo "  Cloudflare tunnel:   $CLOUDFLARE_TUNNEL_NAME"
echo "  GitHub auth:         PAT$([ -n "$HAS_APP" ] && echo " + GitHub App" || echo "")"
echo ""

# Source shared AWS config
source "$SCRIPT_DIR/aws-config.sh"
REGION="$AWS_REGION"
SSH_KEY="$HOME/.ssh/${KEY_PAIR_NAME}.pem"
SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR"

# ---------------------------------------------------------------------------
# Step 3: Create AWS resources
# ---------------------------------------------------------------------------
echo "==========================================="
echo "Step 1/6: Creating AWS resources"
echo "==========================================="
bash "$SCRIPT_DIR/aws-setup.sh"

# ---------------------------------------------------------------------------
# Step 4: Push secrets to Secrets Manager
# ---------------------------------------------------------------------------
echo ""
echo "==========================================="
echo "Step 2/6: Pushing secrets to Secrets Manager"
echo "==========================================="

SECRET_JSON="{"
add_secret() {
  local key="$1" value="${!1:-}"
  [ -z "$value" ] && return
  value=$(printf '%s' "$value" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read())[1:-1])")
  SECRET_JSON="${SECRET_JSON}\"${key}\":\"${value}\","
}

add_secret "GITHUB_TOKEN"
add_secret "GITHUB_APP_CLIENT_ID"
add_secret "GITHUB_APP_PRIVATE_KEY"
add_secret "GITHUB_APP_INSTALLATION_ID"
add_secret "LINEAR_WEBHOOK_SECRET"
add_secret "LINEAR_CLIENT_ID"
add_secret "LINEAR_CLIENT_SECRET"
add_secret "CLAUDE_CODE_OAUTH_TOKEN"
add_secret "ANTHROPIC_API_KEY"
add_secret "SLACK_BOT_TOKEN"
add_secret "SENTRY_ACCESS_TOKEN"
add_secret "METABASE_API_KEY"
add_secret "CLOUDFLARE_API_TOKEN"
add_secret "CLOUDFLARE_ACCOUNT_ID"
add_secret "CLOUDFLARE_ZONE_ID"

SECRET_JSON="${SECRET_JSON%,}}"

aws secretsmanager put-secret-value \
  --secret-id "$SECRET_NAME" \
  --region "$REGION" \
  --secret-string "$SECRET_JSON"
echo "  Secrets pushed to $SECRET_NAME"

# ---------------------------------------------------------------------------
# Step 5: Launch orchestrator EC2
# ---------------------------------------------------------------------------
echo ""
echo "==========================================="
echo "Step 3/6: Launching orchestrator EC2"
echo "==========================================="

ORCH_SG_ID=$(aws ec2 describe-security-groups \
  --group-names "$ORCH_SG_NAME" \
  --query 'SecurityGroups[0].GroupId' \
  --output text --region "$REGION")

SUBNET_ID=$(aws ec2 describe-subnets \
  --region "$REGION" \
  --query 'Subnets[0].SubnetId' \
  --output text)

AMI_ID=$(aws ssm get-parameter \
  --name /aws/service/canonical/ubuntu/server/22.04/stable/current/arm64/hvm/ebs-gp2/ami-id \
  --query 'Parameter.Value' --output text --region "$REGION")

INSTANCE_ID=$(aws ec2 run-instances \
  --region "$REGION" \
  --image-id "$AMI_ID" \
  --instance-type "$ORCH_INSTANCE_TYPE" \
  --key-name "$KEY_PAIR_NAME" \
  --security-group-ids "$ORCH_SG_ID" \
  --subnet-id "$SUBNET_ID" \
  --iam-instance-profile "Name=$ORCH_PROFILE_NAME" \
  --associate-public-ip-address \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=hermes-orchestrator},{Key=Project,Value=hermes}]" \
  --query 'Instances[0].InstanceId' \
  --output text)

echo "  Instance: $INSTANCE_ID"
echo "  Waiting for instance to be running..."
aws ec2 wait instance-running --instance-ids "$INSTANCE_ID" --region "$REGION"

PUBLIC_IP=$(aws ec2 describe-instances \
  --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' \
  --output text --region "$REGION")
echo "  Public IP: $PUBLIC_IP"

echo "  Waiting for SSH..."
for i in $(seq 1 30); do
  if ssh $SSH_OPTS ubuntu@"$PUBLIC_IP" "echo ok" >/dev/null 2>&1; then
    break
  fi
  [ "$i" -eq 30 ] && echo "  ERROR: SSH not ready after 60s" && exit 1
  sleep 2
done
echo "  SSH ready"

# ---------------------------------------------------------------------------
# Step 6: Run setup-orchestrator.sh on instance
# ---------------------------------------------------------------------------
echo ""
echo "==========================================="
echo "Step 4/6: Setting up orchestrator (deps, repo, tunnel)"
echo "==========================================="

GH_TOKEN_FOR_CLONE="${GITHUB_TOKEN:-}"

# Derive REPO_URL from the local git remote so the instance clones the user's fork
REPO_URL="https://x-access-token:${GH_TOKEN_FOR_CLONE}@$(git -C "$ROOT_DIR" remote get-url origin | sed 's|.*github.com[:/]||; s|\.git$||; s|^|github.com/|').git"

ssh $SSH_OPTS ubuntu@"$PUBLIC_IP" \
  "GITHUB_TOKEN='${GH_TOKEN_FOR_CLONE}' REPO_URL='${REPO_URL}' CLOUDFLARE_HOSTNAME='${CLOUDFLARE_HOSTNAME}' CLOUDFLARE_TUNNEL_NAME='${CLOUDFLARE_TUNNEL_NAME}' bash -s" \
  < "$SCRIPT_DIR/setup-orchestrator.sh"

# ---------------------------------------------------------------------------
# Step 7: Deploy orchestrator
# ---------------------------------------------------------------------------
echo ""
echo "==========================================="
echo "Step 5/6: Deploying orchestrator"
echo "==========================================="

ssh $SSH_OPTS ubuntu@"$PUBLIC_IP" \
  "bash /opt/agent/hermes-swe/scripts/deploy-orchestrator.sh"

# ---------------------------------------------------------------------------
# Step 8: Health check
# ---------------------------------------------------------------------------
echo ""
echo "==========================================="
echo "Step 6/6: Health check"
echo "==========================================="

for i in $(seq 1 15); do
  HEALTH=$(ssh $SSH_OPTS ubuntu@"$PUBLIC_IP" "curl -sf http://localhost:${ORCH_PORT:-3001}/health 2>/dev/null" || echo "")
  if [ -n "$HEALTH" ]; then
    echo "  $HEALTH"
    break
  fi
  [ "$i" -eq 15 ] && echo "  WARNING: Health check failed. Check: ssh -i $SSH_KEY ubuntu@$PUBLIC_IP 'journalctl -u orchestrator -n 30'"
  sleep 1
done

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo ""
echo "==========================================="
echo "Setup complete!"
echo "==========================================="
echo ""
echo "  Orchestrator: $PUBLIC_IP"
echo "  Tunnel:       https://$CLOUDFLARE_HOSTNAME"
echo "  SSH:          ssh -i $SSH_KEY ubuntu@$PUBLIC_IP"
echo ""
echo "--- Next steps ---"
echo "  1. Connect Linear:  https://$CLOUDFLARE_HOSTNAME/oauth/install"
echo "  2. Bake an AMI:"
echo "       ssh -i $SSH_KEY ubuntu@$PUBLIC_IP"
echo "       bash /opt/agent/hermes-swe/scripts/bake-ami.sh --repo your-org/your-app"
echo "  3. Assign a Linear ticket to test!"
