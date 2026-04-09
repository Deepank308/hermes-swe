# Cloudflare Setup

Cloudflare serves two purposes in this infrastructure:

1. **Orchestrator Tunnel** (required) — exposes the orchestrator's webhook endpoint to the internet so Linear can reach it, without needing a public IP or opening inbound ports
2. **Preview Tunnels** (optional) — creates per-session public URLs so reviewers can see the agent's changes live

## Part A: Orchestrator Tunnel (Required)

> **Note:** If you're using `scripts/setup.sh`, Part A is handled automatically — the script runs `cloudflared tunnel login/create/route` on the orchestrator instance. The steps below are for manual setup or reference.

The orchestrator runs on a private EC2 instance. A Cloudflare Tunnel provides secure HTTPS ingress for Linear webhooks and the OAuth callback.

### Prerequisites

- A domain with DNS managed by Cloudflare
- `cloudflared` installed locally: `brew install cloudflared` (macOS) or see [Cloudflare docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)

### Step 1: Authenticate

```bash
cloudflared tunnel login
```

This opens a browser to authorize cloudflared with your Cloudflare account. A certificate is saved to `~/.cloudflared/cert.pem`.

### Step 2: Create a Tunnel

```bash
cloudflared tunnel create hermes
```

This creates a tunnel and saves credentials to `~/.cloudflared/<tunnel-id>.json`. Note the **Tunnel ID** from the output.

### Step 3: Create a DNS Record

Route your chosen subdomain to the tunnel:

```bash
cloudflared tunnel route dns hermes hermes.example.com
```

This creates a CNAME record: `hermes.example.com` → `<tunnel-id>.cfargotunnel.com`

### Step 4: Copy Credentials to Orchestrator

```bash
scp -i ~/.ssh/hermes-key.pem \
  ~/.cloudflared/<tunnel-id>.json \
  ubuntu@<orchestrator-ip>:/tmp/cloudflared-credentials.json
```

### Step 5: Configure the Tunnel

SSH into the orchestrator and create the config:

```bash
ssh -i ~/.ssh/hermes-key.pem ubuntu@<orchestrator-ip>
```

```bash
sudo mkdir -p /etc/cloudflared

sudo tee /etc/cloudflared/config.yml > /dev/null <<EOF
tunnel: <tunnel-id>
credentials-file: /etc/cloudflared/<tunnel-id>.json

ingress:
  - hostname: hermes.example.com
    service: http://localhost:3001
  - service: http_status:404
EOF

# Move credentials to the config directory
sudo mv /tmp/cloudflared-credentials.json /etc/cloudflared/<tunnel-id>.json
sudo chmod 600 /etc/cloudflared/<tunnel-id>.json
```

> **Note**: Port 3001 is the orchestrator's public HTTP server. Port 3002 is the internal (agent-facing) server and should NOT be exposed via the tunnel.

### Step 6: Install as a Service

```bash
sudo cloudflared service install
sudo systemctl start cloudflared
sudo systemctl enable cloudflared
```

### Step 7: Verify

```bash
# Check the tunnel is running
sudo systemctl status cloudflared

# Test from outside
curl -s https://hermes.example.com/health
```

You should get a JSON response with `"status": "ok"`.

> **Note**: `setup-orchestrator.sh` automates Steps 5-7 if tunnel credentials are already in `/etc/cloudflared/`.

### Update Your Orchestrator Config

Ensure these values are set in `/opt/agent/env`:

```bash
LINEAR_REDIRECT_URI=https://hermes.example.com/oauth/callback
```

And in your Linear OAuth app settings, the callback URL should be `https://hermes.example.com/oauth/callback`.

---

## Part B: Preview Tunnels (Optional)

Preview tunnels give each agent session a stable public URL for viewing code changes live. When the agent pushes code, it can launch a preview server and create a Cloudflare tunnel to expose it.

### How Preview Tunnels Work

1. The agent runs a preview command (e.g. build + start dev server) on a configured port
2. `preview-launch.sh` creates a Cloudflare tunnel via the API
3. A DNS CNAME record is added: `preview-{session-id}-{config-name}.example.com` → tunnel
4. The preview URL is posted to the Linear ticket
5. On session end, the orchestrator cleans up the tunnel and DNS record

### Prerequisites

- A domain with DNS managed by Cloudflare (can be the same domain as the orchestrator tunnel)
- A Cloudflare API token with specific permissions

### Step 1: Create an API Token

1. Go to **Cloudflare Dashboard** → **My Profile** → **API Tokens** → **Create Token**

2. Click **Create Custom Token**

3. Configure permissions:
   - **Zone** → **DNS** → **Edit** — to create/delete CNAME records for preview subdomains
   - **Account** → **Cloudflare Tunnel** → **Edit** — to create/delete tunnels

4. Under **Zone Resources**, select the zone (domain) you want to use for preview URLs

5. Click **Create Token** and copy the token value

### Step 2: Get Account ID and Zone ID

1. Go to **Cloudflare Dashboard** → select your domain
2. On the **Overview** page, scroll down to the right sidebar
3. Copy:
   - **Account ID** (under "API" section)
   - **Zone ID** (under "API" section)

### Step 3: Add to .env.local

Add these values to your `.env.local` file before running `scripts/setup.sh`:

```
CLOUDFLARE_API_TOKEN=your-api-token
CLOUDFLARE_ACCOUNT_ID=your-account-id
CLOUDFLARE_ZONE_ID=your-zone-id
```

The setup script pushes these to AWS Secrets Manager automatically. If you're setting up manually, ask Claude to help you push secrets to AWS Secrets Manager.

### Step 4: Configure Preview Domain

Set `PREVIEW_DOMAIN` in the orchestrator's `/opt/agent/env`:

```bash
PREVIEW_DOMAIN=example.com
```

This is the base domain for preview URLs. Preview URLs will be subdomains like `preview-a1b2c3d4-app.example.com`.

### Step 5: Configure Preview for Your Repo

See [Repository Configuration — Preview System](repos-json.md#preview-system) for how to set up `launch.json` and preview scripts.

---

## Without Cloudflare Preview Credentials

If `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, or `CLOUDFLARE_ZONE_ID` are not configured, the preview system falls back to **quick tunnels** — temporary `*.trycloudflare.com` URLs that are generated automatically by cloudflared.

Quick tunnels:
- Don't require any API credentials
- Generate random URLs (not stable across restarts)
- Work for simple previews but aren't suitable for auth callbacks (e.g. OAuth redirect URLs)

---

## Tunnel Cleanup

When an agent session ends, the orchestrator automatically cleans up preview tunnels:

1. Lists all tunnels matching the session's prefix pattern (`preview-{session-id-prefix}-*`)
2. Deletes DNS CNAME records for each tunnel
3. Deletes the tunnels themselves

This is best-effort — if cleanup fails (network error, etc.), stale tunnels can be manually deleted via the Cloudflare dashboard or API.

## Troubleshooting

### Tunnel not connecting

- Check cloudflared logs: `sudo journalctl -u cloudflared -f`
- Verify credentials file exists and is readable: `ls -la /etc/cloudflared/`
- Ensure the tunnel hasn't been deleted in the Cloudflare dashboard

### Webhook returns 502 or connection refused

- The orchestrator might not be running: `sudo systemctl status orchestrator`
- Check the ingress port in `/etc/cloudflared/config.yml` matches the orchestrator's public port (3001)

### Preview URLs not working

- Verify Cloudflare API token permissions (Zone:DNS:Edit + Account:Tunnel:Edit)
- Check that `PREVIEW_DOMAIN` is set in `/opt/agent/env`
- Look at agent logs for tunnel creation errors: `ssh ubuntu@<agent-ip> "cat /tmp/cloudflared-*.log"`

### DNS propagation delay

- New CNAME records may take 1-2 minutes to propagate through Cloudflare's network
- The preview script waits 5 seconds after tunnel creation, but complex setups may need more time
