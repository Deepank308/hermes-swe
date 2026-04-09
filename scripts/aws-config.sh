#!/bin/bash
# Shared AWS resource names — sourced by aws-setup.sh and setup-orchestrator.sh
# Change these if deploying to a different account or naming convention.

AWS_REGION="${AWS_REGION:-eu-north-1}"
BUCKET_NAME="hermes-sessions"
SECRET_NAME="hermes/secrets"
ORCH_SG_NAME="hermes-orchestrator-sg"
AGENT_SG_NAME="hermes-agent-sg"
AGENT_BAKE_SG_NAME="hermes-bake-sg"
ORCH_ROLE_NAME="hermes-orchestrator"
ORCH_PROFILE_NAME="hermes-orchestrator"
KEY_PAIR_NAME="hermes-key"
AMI_NAME_PREFIX="hermes-agent"
SESSIONS_KEY="sessions.json"
ORCH_INSTANCE_TYPE="${ORCH_INSTANCE_TYPE:-t4g.nano}"
AGENT_INSTANCE_TYPE="${AGENT_INSTANCE_TYPE:-m6i.xlarge}"
ORCH_PORT="${PORT:-3001}"
ORCH_INTERNAL_PORT="${ORCH_INTERNAL_PORT:-3002}"
AGENT_SERVICE_PORT="${AGENT_SERVICE_PORT:-3000}"
SNAPSHOT_RETENTION_DAYS="${SNAPSHOT_RETENTION_DAYS:-15}"
