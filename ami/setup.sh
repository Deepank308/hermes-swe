#!/bin/bash
set -euo pipefail
IFS=$'\n\t'

# EC2 provisioning script for Ubuntu 22.04
# Installs base dependencies needed for any dev environment + Claude Code

echo "=== AI Agent - EC2 Setup ==="
echo "Starting provisioning at $(date)"

export DEBIAN_FRONTEND=noninteractive

# System updates
echo ">>> Updating system packages..."
apt-get update
apt-get upgrade -y

# Core utilities
echo ">>> Installing core utilities..."
apt-get install -y \
  curl wget git unzip software-properties-common \
  ipset iptables dnsutils aggregate jq \
  apt-transport-https ca-certificates gnupg lsb-release \
  python3-venv

# Docker Engine + Compose plugin
echo ">>> Installing Docker..."
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  tee /etc/apt/sources.list.d/docker.list > /dev/null
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Enable Docker for ubuntu user
usermod -aG docker ubuntu
systemctl enable docker
systemctl start docker

# Node.js 24 (matches app repo .nvmrc)
echo ">>> Installing Node.js 24..."
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs

# pnpm (for ai-agent-infra workspace)
echo ">>> Installing pnpm..."
npm install -g pnpm

# Yarn (common package manager — needed by default/post-agent.sh yarn.lock detection)
echo ">>> Installing Yarn..."
npm install -g yarn

# GitHub CLI
echo ">>> Installing GitHub CLI..."
(type -p wget >/dev/null || apt-get install -y wget) \
  && mkdir -p -m 755 /etc/apt/keyrings \
  && out=$(mktemp) && wget -nv -O"$out" https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  && cat "$out" | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update \
  && apt-get install -y gh

# Note: gh auth + git credential helper are configured at boot time by init-instance.sh

# Claude Code CLI
echo ">>> Installing Claude Code CLI..."
npm install -g @anthropic-ai/claude-code

# Create workspace directory
mkdir -p /workspace
chown ubuntu:ubuntu /workspace

# Note: repo-specific setup (e.g. Yarn, Turbo, Docker pre-pulls) is run
# separately by bake-ami.sh piping ami/<name>/setup.sh after this script.

echo ""
echo "=== Setup complete at $(date) ==="
echo "Installed versions:"
echo "  Docker: $(docker --version)"
echo "  Node:   $(node --version)"
echo "  gh:     $(gh --version | head -1)"
echo "  Claude: $(claude --version 2>/dev/null || echo 'installed')"
