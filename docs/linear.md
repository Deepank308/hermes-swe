# Linear Integration

Linear is the primary interface for triggering and interacting with the agent. When a ticket is assigned to the agent, Linear fires a webhook that starts the entire workflow. Progress is streamed back as activity on the ticket, and users can send messages mid-flight via Linear comments.

## What You Need

1. A **Linear OAuth application** (for API access and activity reporting)
2. A **Linear webhook** (to trigger agent sessions)
3. Three secrets stored in AWS Secrets Manager

## Step 1: Create a Linear OAuth Application

1. Go to **Linear Settings** → **API** → **OAuth Applications** → **New Application**

2. Fill in:
   - **Application name**: Your agent name (e.g. "Hermes")
   - **Callback URL**: `https://<your-tunnel-domain>/oauth/callback`
     - This is the domain you set up via Cloudflare Tunnel (see [Cloudflare Setup](cloudflare.md))
   - **Actor**: Select **Application** (not User)
     - This makes the agent appear as its own entity in Linear, not impersonating a user

3. Under **Scopes**, enable:
   - `read` — read issues, comments, teams
   - `write` — update issues, create branches
   - `comments:create` — post activity updates
   - `app:assignable` — appear in the assignee dropdown
   - `app:mentionable` — appear in @mentions

4. Save the application

5. Copy these values:
   - **Client ID** → store as `LINEAR_CLIENT_ID`
   - **Client Secret** → store as `LINEAR_CLIENT_SECRET`

## Step 2: Configure Webhook

1. Go to **Linear Settings** → **API** → **Webhooks** → **New Webhook**

2. Fill in:
   - **Label**: Your agent name (e.g. "Hermes Webhook")
   - **URL**: `https://<your-tunnel-domain>/webhook`
     - Same domain as the OAuth callback, but `/webhook` path
   - **Events**: Enable **Agent session events** (`AgentSessionEvent`)
     - This fires when a ticket is assigned to the agent or when a user sends a follow-up comment

3. Save the webhook

4. Copy the **Webhook Secret** → store as `LINEAR_WEBHOOK_SECRET`

## Step 3: Add to .env.local

Add these values to your `.env.local` file before running `scripts/setup.sh`:

```
LINEAR_CLIENT_ID=your-oauth-client-id
LINEAR_CLIENT_SECRET=your-oauth-client-secret
LINEAR_WEBHOOK_SECRET=your-webhook-signing-secret
```

The setup script pushes these to AWS Secrets Manager automatically. If you're setting up manually, ask Claude to help you push secrets to AWS Secrets Manager.

## Step 4: Install the App in Your Workspace

After the orchestrator is running:

1. Open `https://<your-tunnel-domain>/oauth/install` in your browser
2. Linear shows an authorization page for your OAuth app
3. Click **Authorize** to grant access to your workspace
4. You're redirected back to the orchestrator with a success message

The agent now appears as an assignable member in your Linear workspace. You can assign tickets to it.

### Multi-Workspace Support

The OAuth flow supports multiple Linear workspaces. Each workspace gets its own OAuth token, stored per-organization. Repeat the install step for each workspace.

---

## How It Works

### Webhook Flow

```
1. User assigns ticket to agent in Linear
2. Linear sends AgentSessionEvent webhook to https://<domain>/webhook
3. Orchestrator verifies webhook signature using LINEAR_WEBHOOK_SECRET
4. Orchestrator provisions an EC2 instance
5. Agent-service starts a Claude Code session
6. Progress posted to Linear as agent activities (thoughts, actions, completion)
```

### Webhook Events

The orchestrator handles two `AgentSessionEvent` actions:

| Action | Trigger | Behavior |
|---|---|---|
| `created` | Ticket assigned to agent | Starts a new session (or queues if at concurrency limit) |
| `prompted` | User comments on an active/completed ticket | Sends the message to the running agent, or resumes the session |

### Activity Reporting

The agent streams progress to Linear using the Agent Activity API:

- **Thoughts** — internal reasoning (shown as collapsible sections)
- **Actions** — tool use (file reads, bash commands, code edits)
- **Responses** — final completion message with PR link

### OAuth Token Management

- Tokens are stored per-organization in `.linear-tokens.json` on the orchestrator
- Access tokens expire after ~1 hour
- The orchestrator automatically refreshes tokens using the refresh token
- Token refresh happens transparently — no manual intervention needed

### Session Resume

When a user comments on a completed ticket:

1. Linear fires a `prompted` webhook event
2. The orchestrator checks if the original EC2 instance is still alive (30-minute grace period)
3. If alive: sends the message directly to the running agent-service
4. If terminated: provisions a new EC2, restores the previous Claude session artifacts, and resumes

---

## Troubleshooting

### Webhook not firing

- Verify the webhook URL is correct: `https://<your-tunnel-domain>/webhook`
- Check that "Agent session events" is enabled in webhook settings
- Ensure the Cloudflare Tunnel is running: `sudo systemctl status cloudflared`
- Check orchestrator logs: `sudo journalctl -u orchestrator -f`

### Signature verification failed

- Ensure `LINEAR_WEBHOOK_SECRET` in Secrets Manager matches the webhook secret in Linear settings
- The secret is the signing key shown when you create the webhook, not the webhook ID

### OAuth redirect mismatch

- The callback URL in your Linear OAuth app must exactly match `LINEAR_REDIRECT_URI` in the orchestrator env
- Both must use HTTPS and the same domain
- Example: `https://hermes.example.com/oauth/callback`

### Agent not appearing as assignable

- Ensure the OAuth app has `app:assignable` scope
- Ensure the app is installed (visit `/oauth/install`)
- The app only appears assignable in workspaces where it's been installed

### "Entity not found" errors in logs

- This usually means the Linear API token has expired and refresh failed
- Check `.linear-tokens.json` on the orchestrator for the token's `expiresAt`
- Re-install the app via `/oauth/install` to get a fresh token
