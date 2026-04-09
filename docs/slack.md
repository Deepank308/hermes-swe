# Slack Notifications

Slack integration is **optional**. When configured, the agent sends threaded DM notifications to the person who created each Linear ticket — keeping them updated on session progress without leaving Slack.

## What You Get

- **Session started**: DM when the agent begins working on a ticket
- **Session completed**: DM with PR link when the agent finishes
- **Session failed**: DM if something goes wrong
- **User input needed**: DM when the agent has a question
- **All updates in one thread**: Subsequent messages reply in the same thread for easy tracking

If the agent can't find the ticket creator's Slack account (e.g. different email), it falls back to posting in a public channel.

## Step 1: Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**

2. Fill in:
   - **App Name**: Your agent name (e.g. "Hermes Agent")
   - **Workspace**: Select your Slack workspace

3. Click **Create App**

## Step 2: Configure Bot Scopes

1. In the app settings, go to **OAuth & Permissions**

2. Under **Bot Token Scopes**, add:

| Scope | Purpose |
|---|---|
| `users:read.email` | Look up Slack user by their Linear email address |
| `im:write` | Open DM channels with users |
| `chat:write` | Post messages in DM channels and public channels |

## Step 3: Install to Workspace

1. Go to **Install App** in the left sidebar
2. Click **Install to Workspace**
3. Review the permissions and click **Allow**
4. Copy the **Bot User OAuth Token** (starts with `xoxb-`)

## Step 4: Add to .env.local

Add these values to your `.env.local` file before running `scripts/setup.sh`:

```
SLACK_BOT_TOKEN=xoxb-your-bot-token-here
SLACK_CHANNEL_ID=C0123456789
```

The setup script pushes these to AWS Secrets Manager automatically. If you're setting up manually, ask Claude to help you push secrets to AWS Secrets Manager.

### Fallback Channel

`SLACK_CHANNEL_ID` is the public channel where notifications are posted when:
- The ticket creator's email doesn't match any Slack user
- Opening a DM fails for any reason

To get a channel ID: right-click the channel in Slack → **View channel details** → scroll down to find the **Channel ID**.

> **Note**: The bot must be a member of the fallback channel. Invite it with `/invite @YourAgentName` in the channel.

---

## How It Works

1. When a session starts, the orchestrator looks up the ticket creator's email from Linear
2. It searches Slack for a user with that email (`users.lookupByEmail`)
3. If found, opens a DM channel with that user (`conversations.open`)
4. Posts the first notification in the DM
5. All subsequent updates for the same session are threaded under the first message
6. Thread timestamps are persisted in the session store, surviving orchestrator restarts

### Matching Users

The Slack integration matches users by email:
- Linear ticket creator's email → Slack user with the same email

If the emails don't match between Linear and Slack (e.g. personal vs. work email), the notification falls back to the public channel.

---

## Troubleshooting

### Bot not posting messages

- Verify `SLACK_BOT_TOKEN` is set in Secrets Manager
- Check that the token starts with `xoxb-` (not `xoxp-` which is a user token)
- Restart the orchestrator after updating secrets: `sudo systemctl restart orchestrator`

### Messages going to public channel instead of DMs

- The ticket creator's Linear email doesn't match their Slack email
- Verify emails match: check the user's Linear profile and Slack profile
- The Slack API `users.lookupByEmail` requires an exact email match

### "not_in_channel" error

- The bot needs to be invited to the fallback public channel
- Run `/invite @YourAgentName` in the channel

### No notifications at all

- Check that `SLACK_BOT_TOKEN` is included in the Secrets Manager JSON
- Check orchestrator logs for Slack-related errors: `sudo journalctl -u orchestrator | grep -i slack`
- Verify the bot has all three required scopes (`users:read.email`, `im:write`, `chat:write`)
