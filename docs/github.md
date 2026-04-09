# GitHub Authentication

The agent needs GitHub access to clone repositories, push branches, and create pull requests. Two authentication methods are supported:

- **GitHub App** (recommended) — short-lived installation tokens with automatic refresh
- **Personal Access Token** — simpler setup, but tied to a user account

## Option A: GitHub App (Recommended)

GitHub Apps provide fine-grained, auditable access with automatically rotating tokens. The orchestrator generates short-lived installation tokens (~1 hour) and refreshes them transparently.

### Step 1: Create a GitHub App

1. Go to **GitHub Settings** → **Developer settings** → **GitHub Apps** → **New GitHub App**

2. Fill in:
   - **GitHub App name**: Your agent name (e.g. "Hermes Agent")
   - **Homepage URL**: Your domain or repo URL
   - **Webhook**: Uncheck "Active" (not needed — Linear handles webhooks)

3. Under **Permissions** → **Repository permissions**:
   - **Contents**: Read and write (clone repos, push branches)
   - **Pull requests**: Read and write (create PRs, read PR comments)
   - **Metadata**: Read-only (required by GitHub)

4. Under **Where can this GitHub App be installed?**:
   - Select "Only on this account" (or "Any account" if you want to use it across orgs)

5. Click **Create GitHub App**

6. On the app settings page, note the **App ID** (shown near the top) — this is your `GITHUB_APP_CLIENT_ID`

### Step 2: Generate a Private Key

1. On the app settings page, scroll to **Private keys**
2. Click **Generate a private key**
3. A `.pem` file downloads — this is your `GITHUB_APP_PRIVATE_KEY`

### Step 3: Install the App on Your Organization

1. On the app settings page, click **Install App** in the left sidebar
2. Select your organization
3. Choose **All repositories** or select specific repositories
4. Click **Install**
5. After installation, note the **Installation ID** from the URL:
   ```
   https://github.com/settings/installations/12345678
                                               ^^^^^^^^
                                               This is the Installation ID
   ```

### Step 4: Add to .env.local

Add these values to your `.env.local` file before running `scripts/setup.sh`:

```
GITHUB_APP_CLIENT_ID=123456
GITHUB_APP_INSTALLATION_ID=12345678
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
MIIEow...
-----END RSA PRIVATE KEY-----"
```

The setup script pushes these to AWS Secrets Manager automatically. If you're setting up manually, ask Claude to help you push secrets to AWS Secrets Manager.

### How It Works

1. Orchestrator uses the App ID + private key to authenticate as the GitHub App
2. For each agent session, it generates a short-lived installation token (~1 hour)
3. The token is passed to the agent EC2 via user-data
4. On the agent, the token is configured as a `gh` CLI credential helper
5. When the token nears expiry, agent-service requests a fresh one from the orchestrator via the `/github-refresh-token` internal endpoint
6. The orchestrator generates a new installation token and returns it

### Benefits

- **Short-lived tokens**: Each token expires in ~1 hour, limiting exposure
- **Automatic refresh**: No manual token rotation needed
- **Auditable**: All actions attributed to the GitHub App, not a user
- **Fine-grained**: Only the permissions you configure, nothing more
- **Per-repo control**: Install on specific repos only

---

## Option B: Personal Access Token

A PAT is simpler to set up but provides broader access and doesn't auto-refresh.

### Step 1: Generate a Token

**Fine-grained PAT** (recommended over classic):

1. Go to **GitHub Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens**
2. Click **Generate new token**
3. Fill in:
   - **Token name**: Your agent name
   - **Expiration**: Choose an appropriate duration
   - **Repository access**: Select the repositories the agent needs
   - **Permissions**:
     - **Contents**: Read and write
     - **Pull requests**: Read and write
     - **Metadata**: Read-only
4. Click **Generate token** and copy it

**Classic PAT** (simpler but broader):

1. Go to **GitHub Settings** → **Developer settings** → **Personal access tokens** → **Tokens (classic)**
2. Click **Generate new token**
3. Select the `repo` scope
4. Click **Generate token** and copy it

### Step 2: Add to .env.local

Add to your `.env.local` file:

```
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
```

The setup script pushes this to AWS Secrets Manager automatically. If you're setting up manually, ask Claude to help you push secrets to AWS Secrets Manager.

### Trade-offs

| | GitHub App | Personal Access Token |
|---|---|---|
| Token lifetime | ~1 hour (auto-refreshed) | Days to never (manual rotation) |
| Attribution | Actions attributed to the App | Actions attributed to your user |
| Permissions | Fine-grained per-repo | Broad (repo scope covers everything) |
| Setup complexity | More steps | Simpler |
| Multi-org | One App, multiple installations | One token per org |

---

## How the Agent Uses GitHub

Regardless of auth method, the agent EC2 is configured the same way at boot:

1. `init-instance.sh` writes the token to `~/.config/gh/hosts.yml` (GitHub CLI config)
2. Git is configured to use `gh auth git-credential` as the credential helper
3. SSH git URLs are rewritten to HTTPS: `git@github.com:` → `https://github.com/`
4. The agent can then `git clone`, `git push`, and use `gh pr create` seamlessly

## Troubleshooting

### "Bad credentials" or 401 errors

- **GitHub App**: Check that the Installation ID is correct and the app is still installed on the org
- **PAT**: Check that the token hasn't expired and has the required scopes

### "Resource not accessible by integration"

- The GitHub App doesn't have the required permissions
- Go to the app settings and add the missing repository permission
- Re-install the app on the organization to apply new permissions

### Agent can't push to a repo

- Ensure the repo is included in the GitHub App installation (or the PAT has access)
- Check that **Contents: Read and write** permission is granted

### Token refresh failing (GitHub App only)

- Check orchestrator logs for errors from `/github-refresh-token`
- Verify the private key in Secrets Manager is complete and properly formatted
- Ensure the App hasn't been suspended or uninstalled
