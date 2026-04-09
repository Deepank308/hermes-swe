#!/bin/bash
set -euo pipefail

# Sets up AWS resources for the orchestrator and prints env var values.
# Usage: bash scripts/aws-setup.sh [region]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -n "${1:-}" ] && AWS_REGION="$1"
source "$SCRIPT_DIR/aws-config.sh"
REGION="$AWS_REGION"

echo "=== AWS Setup for AI Agent Orchestrator ==="
echo "Region: $REGION"
echo ""

# --- Helper: ensure a security group exists, revoke all ingress, return its ID ---
ensure_sg() {
  local name="$1" description="$2"
  local sg_id
  sg_id=$(aws ec2 describe-security-groups \
    --group-names "$name" \
    --query 'SecurityGroups[0].GroupId' \
    --output text \
    --region "$REGION" 2>/dev/null || echo "")

  if [ -z "$sg_id" ] || [ "$sg_id" = "None" ]; then
    echo "  Creating: $name" >&2
    sg_id=$(aws ec2 create-security-group \
      --group-name "$name" \
      --description "$description" \
      --region "$REGION" \
      --tag-specifications "ResourceType=security-group,Tags=[{Key=Project,Value=hermes}]" \
      --query 'GroupId' --output text)
  else
    echo "  Exists: $sg_id — resetting ingress rules" >&2
    # Revoke all existing ingress rules so we can re-apply fresh
    local rules
    rules=$(aws ec2 describe-security-groups \
      --group-ids "$sg_id" \
      --query 'SecurityGroups[0].IpPermissions' \
      --output json \
      --region "$REGION")
    if [ "$rules" != "[]" ] && [ -n "$rules" ]; then
      aws ec2 revoke-security-group-ingress \
        --group-id "$sg_id" \
        --ip-permissions "$rules" \
        --region "$REGION" >/dev/null
    fi
  fi
  echo "$sg_id"
}

# --- Orchestrator Security Group ---
echo ">>> Orchestrator Security Group..."
ORCH_SG_ID=$(ensure_sg "$ORCH_SG_NAME" "AI Agent Orchestrator")
echo "  ID: $ORCH_SG_ID"

# --- Agent Security Group ---
echo ""
echo ">>> Agent Security Group..."
AGENT_SG_ID=$(ensure_sg "$AGENT_SG_NAME" "AI Agent EC2 instances")
echo "  ID: $AGENT_SG_ID"

# --- Bake Security Group (SSH open for AMI baking) ---
echo ""
echo ">>> Bake Security Group..."
AGENT_BAKE_SG_ID=$(ensure_sg "$AGENT_BAKE_SG_NAME" "Temporary SG for AMI baking (SSH open)")
echo "  ID: $AGENT_BAKE_SG_ID"

aws ec2 authorize-security-group-ingress \
  --group-id "$AGENT_BAKE_SG_ID" \
  --protocol tcp --port 22 \
  --cidr 0.0.0.0/0 \
  --region "$REGION" >/dev/null
echo "  Rule: SSH (port 22) from anywhere"

# SSH — needed for initial setup and ongoing access
echo ""
echo ">>> Orchestrator inbound rules..."
aws ec2 authorize-security-group-ingress \
  --group-id "$ORCH_SG_ID" \
  --protocol tcp --port 22 \
  --cidr 0.0.0.0/0 \
  --region "$REGION" >/dev/null
echo "  Rule: SSH (port 22) from anywhere"
# Linear webhooks arrive via Cloudflare Tunnel (outbound connection, bypasses SG)

# --- Orchestrator inbound from agent SG (for callbacks) ---
aws ec2 authorize-security-group-ingress \
  --group-id "$ORCH_SG_ID" \
  --protocol tcp --port "$ORCH_INTERNAL_PORT" \
  --source-group "$AGENT_SG_ID" \
  --region "$REGION" >/dev/null
echo ""
echo "  Rule: callbacks (port $ORCH_INTERNAL_PORT) from agent SG"

# SSH + agent service port — only from orchestrator SG
echo ""
echo ">>> Agent inbound rules..."
aws ec2 authorize-security-group-ingress \
  --group-id "$AGENT_SG_ID" \
  --protocol tcp --port 22 \
  --source-group "$ORCH_SG_ID" \
  --region "$REGION" >/dev/null
echo "  Rule: SSH (port 22) from orchestrator SG"

aws ec2 authorize-security-group-ingress \
  --group-id "$AGENT_SG_ID" \
  --protocol tcp --port $AGENT_SERVICE_PORT \
  --source-group "$ORCH_SG_ID" \
  --region "$REGION" >/dev/null
echo "  Rule: Agent service (port $AGENT_SERVICE_PORT) from orchestrator SG"

# --- Subnet (first public subnet) ---
echo ""
echo ">>> Subnet..."
SUBNET_ID=$(aws ec2 describe-subnets \
  --region "$REGION" \
  --query 'Subnets[?MapPublicIpOnLaunch==`true`] | [0].SubnetId' \
  --output text)

if [ -z "$SUBNET_ID" ] || [ "$SUBNET_ID" = "None" ]; then
  echo "  ERROR: No public subnet found in $REGION. Create one or enable auto-assign public IP."
  exit 1
fi
echo "  Found: $SUBNET_ID"

# --- S3 Bucket ---
echo ""
echo ">>> S3 Bucket..."
if aws s3 ls "s3://$BUCKET_NAME" --region "$REGION" >/dev/null 2>&1; then
  echo "  Exists: $BUCKET_NAME"
else
  echo "  Creating: $BUCKET_NAME"
  aws s3 mb "s3://$BUCKET_NAME" --region "$REGION"
  aws s3api put-bucket-tagging --bucket "$BUCKET_NAME" --region "$REGION" \
    --tagging 'TagSet=[{Key=Project,Value=hermes}]'
  echo "  Created: $BUCKET_NAME"
fi

# --- Secrets Manager ---
echo ""
echo ">>> Secrets Manager..."
if aws secretsmanager describe-secret --secret-id "$SECRET_NAME" --region "$REGION" >/dev/null 2>&1; then
  echo "  Exists: $SECRET_NAME"
else
  echo "  Creating: $SECRET_NAME (with placeholder values — update before use!)"
  aws secretsmanager create-secret \
    --name "$SECRET_NAME" \
    --region "$REGION" \
    --tags '[{"Key":"Project","Value":"hermes"}]' \
    --secret-string '{
      "GITHUB_TOKEN": "REPLACE_ME",
      "LINEAR_WEBHOOK_SECRET": "REPLACE_ME",
      "LINEAR_CLIENT_ID": "REPLACE_ME",
      "LINEAR_CLIENT_SECRET": "REPLACE_ME",
      "SLACK_BOT_TOKEN": "",
      "CLAUDE_CODE_OAUTH_TOKEN": "REPLACE_ME",
      "SENTRY_ACCESS_TOKEN": "",
      "METABASE_API_KEY": ""
    }'
  echo "  Created: $SECRET_NAME"
  echo "  WARNING: Update secret values with real credentials:"
  echo "    aws secretsmanager put-secret-value --secret-id $SECRET_NAME --region $REGION --secret-string '{...}'"
fi

# --- IAM Instance Profile (for orchestrator EC2) ---
echo ""
echo ">>> IAM Instance Profile..."
ACCOUNT_ID=$(aws sts get-caller-identity --query 'Account' --output text)

if aws iam get-instance-profile --instance-profile-name "$ORCH_PROFILE_NAME" >/dev/null 2>&1; then
  echo "  Exists: $ORCH_PROFILE_NAME"
else
  echo "  Creating role: $ORCH_ROLE_NAME"
  aws iam create-role \
    --role-name "$ORCH_ROLE_NAME" \
    --tags '[{"Key":"Project","Value":"hermes"}]' \
    --assume-role-policy-document '{
      "Version": "2012-10-17",
      "Statement": [{
        "Effect": "Allow",
        "Principal": { "Service": "ec2.amazonaws.com" },
        "Action": "sts:AssumeRole"
      }]
    }' >/dev/null

  echo "  Creating instance profile: $ORCH_PROFILE_NAME"
  aws iam create-instance-profile \
    --instance-profile-name "$ORCH_PROFILE_NAME" >/dev/null

  aws iam add-role-to-instance-profile \
    --instance-profile-name "$ORCH_PROFILE_NAME" \
    --role-name "$ORCH_ROLE_NAME"

  echo "  Created: $ORCH_PROFILE_NAME"
fi

# Always update the inline policy (idempotent)
echo "  Updating inline policy..."
aws iam put-role-policy \
  --role-name "$ORCH_ROLE_NAME" \
  --policy-name orchestrator-access \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Action": "secretsmanager:GetSecretValue",
        "Resource": "arn:aws:secretsmanager:'"$REGION"':'"$ACCOUNT_ID"':secret:'"$SECRET_NAME"'-*"
      },
      {
        "Effect": "Allow",
        "Action": ["s3:GetObject", "s3:PutObject", "s3:HeadObject"],
        "Resource": "arn:aws:s3:::'"$BUCKET_NAME"'/*"
      },
      {
        "Effect": "Allow",
        "Action": "s3:ListBucket",
        "Resource": "arn:aws:s3:::'"$BUCKET_NAME"'"
      },
      {
        "Effect": "Allow",
        "Action": [
          "ec2:RunInstances",
          "ec2:TerminateInstances",
          "ec2:DescribeInstances",
          "ec2:DescribeSecurityGroups",
          "ec2:DescribeImages",
          "ec2:DescribeKeyPairs",
          "ec2:CreateImage",
          "ec2:CreateTags",
          "ec2:CreateSnapshot",
          "ec2:DeleteSnapshot",
          "ec2:DescribeSnapshots",
          "ec2:DescribeVolumes"
        ],
        "Resource": "*"
      },
      {
        "Effect": "Allow",
        "Action": "iam:PassRole",
        "Resource": "arn:aws:iam::'"$ACCOUNT_ID"':role/*",
        "Condition": {
          "StringEquals": { "iam:PassedToService": "ec2.amazonaws.com" }
        }
      }
    ]
  }'

# --- AMI Lookup ---
echo ""
echo ">>> Agent AMI..."
AMI_NAME_PATTERN="${AMI_NAME_PREFIX}-*"
AMI_ID=$(aws ec2 describe-images \
  --owners self \
  --region "$REGION" \
  --filters "Name=name,Values=${AMI_NAME_PATTERN}" \
  --query 'Images | sort_by(@, &CreationDate) | [-1].ImageId' \
  --output text 2>/dev/null || echo "None")

if [ -n "$AMI_ID" ] && [ "$AMI_ID" != "None" ]; then
  AMI_NAME=$(aws ec2 describe-images \
    --image-ids "$AMI_ID" \
    --region "$REGION" \
    --query 'Images[0].Name' --output text)
  echo "  Found: $AMI_ID ($AMI_NAME)"
else
  AMI_ID=""
  echo "  No AMI found matching '${AMI_NAME_PATTERN}' — bake one first (ami/setup.sh + ami/prepare-ami.sh)"
fi

# --- Key Pair ---
echo ""
echo ">>> Key Pair..."
KEY_NAME=""
if aws ec2 describe-key-pairs --key-names "$KEY_PAIR_NAME" --region "$REGION" >/dev/null 2>&1; then
  KEY_NAME="$KEY_PAIR_NAME"
  echo "  Exists: $KEY_NAME"
else
  echo "  Creating: $KEY_PAIR_NAME"
  KEY_FILE="$KEY_PAIR_NAME.pem"
  aws ec2 create-key-pair \
    --key-name "$KEY_PAIR_NAME" \
    --region "$REGION" \
    --tag-specifications "ResourceType=key-pair,Tags=[{Key=Project,Value=hermes}]" \
    --query 'KeyMaterial' --output text > "$KEY_FILE"
  chmod 400 "$KEY_FILE"
  mkdir -p ~/.ssh
  cp "$KEY_FILE" ~/.ssh/"$KEY_FILE"
  chmod 400 ~/.ssh/"$KEY_FILE"
  KEY_NAME="$KEY_PAIR_NAME"
  echo "  Created: $KEY_NAME (private key saved to ~/.ssh/$KEY_FILE)"
fi

# --- Find latest Ubuntu AMIs ---
echo ""
echo ">>> Ubuntu AMIs..."

# Orchestrator: arm64 (t4g.nano is Graviton)
ORCH_AMI_ID=$(aws ec2 describe-images \
  --owners 099720109477 \
  --region "$REGION" \
  --filters \
    "Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*" \
    "Name=architecture,Values=arm64" \
    "Name=state,Values=available" \
  --query 'Images | sort_by(@, &CreationDate) | [-1].ImageId' \
  --output text 2>/dev/null || echo "None")
[ "$ORCH_AMI_ID" = "None" ] && ORCH_AMI_ID=""

if [ -n "$ORCH_AMI_ID" ]; then
  echo "  Orchestrator: $ORCH_AMI_ID (Ubuntu 24.04 arm64)"
else
  ORCH_AMI_ID="<UBUNTU_ARM64_AMI_ID>"
  echo "  WARNING: Could not find arm64 Ubuntu AMI — replace $ORCH_AMI_ID in the command below"
fi

# Agent base: amd64 (m6i.xlarge is x86)
AGENT_BASE_AMI_ID=$(aws ec2 describe-images \
  --owners 099720109477 \
  --region "$REGION" \
  --filters \
    "Name=name,Values=ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*" \
    "Name=architecture,Values=x86_64" \
    "Name=state,Values=available" \
  --query 'Images | sort_by(@, &CreationDate) | [-1].ImageId' \
  --output text 2>/dev/null || echo "None")
[ "$AGENT_BASE_AMI_ID" = "None" ] && AGENT_BASE_AMI_ID=""

if [ -n "$AGENT_BASE_AMI_ID" ]; then
  echo "  Agent base: $AGENT_BASE_AMI_ID (Ubuntu 22.04 amd64)"
else
  AGENT_BASE_AMI_ID="<UBUNTU_AMD64_AMI_ID>"
  echo "  WARNING: Could not find amd64 Ubuntu AMI — replace $AGENT_BASE_AMI_ID in the command below"
fi


# --- Output ---
echo ""
echo "==========================================="
echo "Step 1: Bake agent AMI"
echo "==========================================="
echo ""

BAKE_CMD="aws ec2 run-instances \\
  --region $REGION \\
  --image-id $AGENT_BASE_AMI_ID \\
  --instance-type $AGENT_INSTANCE_TYPE \\
  --subnet-id $SUBNET_ID \\
  --block-device-mappings '[{\"DeviceName\":\"/dev/sda1\",\"Ebs\":{\"VolumeSize\":100,\"VolumeType\":\"gp3\"}}]' \\
  --security-group-ids $AGENT_BAKE_SG_ID \\
  --associate-public-ip-address"
[ -n "$KEY_NAME" ] && BAKE_CMD="$BAKE_CMD \\
  --key-name $KEY_NAME"
BAKE_CMD="$BAKE_CMD \\
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=hermes-ami-bake},{Key=Project,Value=hermes}]' \\
  --query 'Instances[0].InstanceId' --output text"

echo "$BAKE_CMD"
echo ""
echo "  # Then SSH in and run:"
echo "  ssh ubuntu@<PUBLIC_IP> 'sudo bash -s' < ami/setup.sh"
echo "  ssh ubuntu@<PUBLIC_IP> 'GITHUB_TOKEN=ghp_xxx sudo -E bash -s' < ami/prepare-ami.sh"
echo "  # Create AMI snapshot from AWS console — name it hermes-agent-YYYY-MM-DD"
echo "  # Terminate the bake instance after snapshot completes"

echo ""
echo "==========================================="
echo "AWS resources ready!"
echo "==========================================="
echo ""
echo "If running via scripts/setup.sh, this step is done."
echo "For manual setup, see SETUP.md."
