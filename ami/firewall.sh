#!/bin/bash
set -euo pipefail
IFS=$'\n\t'

# Outbound network restriction for AI agent EC2 instances
# Restricts all outbound traffic except to explicitly allowed domains
# Safe to run before or after docker compose — Docker adds its own iptables rules on startup

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOMAINS_FILE="${SCRIPT_DIR}/allowed-domains.txt"

echo "=== AI Agent - Firewall Setup ==="

if [ ! -f "$DOMAINS_FILE" ]; then
  echo "ERROR: $DOMAINS_FILE not found"
  exit 1
fi

# 1. Reset firewall to clean state (preserves Docker DNS rules)
echo "Resetting firewall..."
bash "${SCRIPT_DIR}/reset-firewall.sh"

# 2. Allow DNS and localhost before any restrictions
# Outbound DNS
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
# Inbound DNS responses
iptables -A INPUT -p udp --sport 53 -j ACCEPT

# Outbound SSH
iptables -A OUTPUT -p tcp --dport 22 -j ACCEPT
# Inbound SSH responses
iptables -A INPUT -p tcp --sport 22 -m state --state ESTABLISHED -j ACCEPT

# Localhost
iptables -A INPUT -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT

# 3. Create ipset with CIDR support
ipset create allowed-domains hash:net

# 4. Fetch GitHub IP ranges (CIDR blocks, not individual IPs)
echo "Fetching GitHub IP ranges..."
gh_ranges=$(curl -s https://api.github.com/meta)
if [ -z "$gh_ranges" ]; then
  echo "ERROR: Failed to fetch GitHub IP ranges"
  exit 1
fi
if ! echo "$gh_ranges" | jq -e '.web and .api and .git' >/dev/null; then
  echo "ERROR: GitHub API response missing required fields"
  exit 1
fi

echo "Processing GitHub IPs..."
while read -r cidr; do
  if [[ ! "$cidr" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/[0-9]{1,2}$ ]]; then
    echo "ERROR: Invalid CIDR range from GitHub meta: $cidr"
    exit 1
  fi
  echo "Adding GitHub range $cidr"
  ipset add allowed-domains "$cidr"
done < <(echo "$gh_ranges" | jq -r '(.web + .api + .git)[]' | aggregate -q)

# 5. Resolve and add domains from allowed-domains.txt
echo "Resolving allowed domains..."
while IFS= read -r domain; do
  # Skip comments and blank lines
  [[ -z "$domain" || "$domain" =~ ^[[:space:]]*# ]] && continue
  # Trim whitespace
  domain=$(echo "$domain" | xargs)
  [ -z "$domain" ] && continue

  echo "Resolving $domain..."
  ips=$(dig +noall +answer A "$domain" | awk '$4 == "A" {print $5}')
  if [ -z "$ips" ]; then
    echo "WARNING: Failed to resolve $domain - skipping"
    continue
  fi
  while read -r ip; do
    if [[ ! "$ip" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
      echo "WARNING: Invalid IP from DNS for $domain: $ip - skipping"
      continue
    fi
    echo "Adding $ip for $domain"
    ipset add allowed-domains "$ip" 2>/dev/null || true
  done < <(echo "$ips")
done < "$DOMAINS_FILE"

# 6. Allow VPC network (orchestrator callbacks, Docker, etc.)
# Use instance metadata to get VPC CIDR — covers all subnets, not just the agent's /24
IMDS_TOKEN=$(curl -sf -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
MAC=$(curl -sf -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/mac)
VPC_CIDR=$(curl -sf -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" "http://169.254.169.254/latest/meta-data/network/interfaces/macs/$MAC/vpc-ipv4-cidr-block")
if [ -z "$VPC_CIDR" ]; then
  echo "ERROR: Failed to detect VPC CIDR from instance metadata"
  exit 1
fi
echo "VPC CIDR detected as: $VPC_CIDR"

iptables -A INPUT -s "$VPC_CIDR" -j ACCEPT
iptables -A OUTPUT -d "$VPC_CIDR" -j ACCEPT

# 7. Allow Docker inter-container traffic (bridge interfaces)
iptables -A FORWARD -i docker0 -j ACCEPT
iptables -A FORWARD -o docker0 -j ACCEPT
iptables -A FORWARD -i br-+ -j ACCEPT
iptables -A FORWARD -o br-+ -j ACCEPT

# 7b. Allow host→container traffic (Docker port-mapped services)
# Docker NAT rewrites localhost:port to the container bridge IP, so OUTPUT rules
# must allow traffic to Docker bridge subnets (not just loopback).
# Docker assigns bridge networks from 172.16.0.0/12 by default — allow the whole range
# rather than discovering at runtime (Compose networks may not exist yet).
echo "Allowing host→container traffic for Docker subnet range 172.16.0.0/12"
iptables -A OUTPUT -d 172.16.0.0/12 -j ACCEPT

# 8. Set default policies to DROP
iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT DROP

# Allow established connections for already approved traffic
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# Allow only specific outbound traffic to allowed domains
iptables -A OUTPUT -m set --match-set allowed-domains dst -j ACCEPT

# Explicitly REJECT all other outbound traffic for immediate feedback
iptables -A OUTPUT -j REJECT --reject-with icmp-admin-prohibited

echo "Firewall configuration complete"

# 8. Verify
echo "Verifying firewall rules..."
if curl --connect-timeout 5 https://example.com >/dev/null 2>&1; then
  echo "ERROR: Firewall verification failed - was able to reach https://example.com"
  exit 1
else
  echo "Firewall verification passed - unable to reach https://example.com as expected"
fi

if ! curl --connect-timeout 5 https://api.github.com/zen >/dev/null 2>&1; then
  echo "ERROR: Firewall verification failed - unable to reach https://api.github.com"
  exit 1
else
  echo "Firewall verification passed - able to reach https://api.github.com as expected"
fi
