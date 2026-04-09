#!/bin/bash
set -euo pipefail

# Reset all iptables rules and ipsets to a clean state (allow-all).
# Used by: prepare-ami.sh (before snapshot) and firewall.sh (before applying rules).

# Preserve Docker DNS NAT rules if present
DOCKER_DNS_RULES=$(iptables-save -t nat | grep "127\.0\.0\.11" || true)

# Flush all tables
iptables -F
iptables -X
iptables -t nat -F
iptables -t nat -X
iptables -t mangle -F
iptables -t mangle -X

# Reset default policies to ACCEPT
iptables -P INPUT ACCEPT
iptables -P FORWARD ACCEPT
iptables -P OUTPUT ACCEPT

# Destroy ipsets
ipset flush 2>/dev/null || true
ipset destroy 2>/dev/null || true

# Restore Docker DNS rules if they existed
if [ -n "$DOCKER_DNS_RULES" ]; then
  iptables -t nat -N DOCKER_OUTPUT 2>/dev/null || true
  iptables -t nat -N DOCKER_POSTROUTING 2>/dev/null || true
  echo "$DOCKER_DNS_RULES" | xargs -L 1 iptables -t nat
  echo "Docker DNS rules restored."
fi

echo "Firewall reset to allow-all."
