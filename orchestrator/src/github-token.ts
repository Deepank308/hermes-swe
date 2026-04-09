import { createAppAuth } from "@octokit/auth-app";
import { config } from "./config.js";

let authInstance: ReturnType<typeof createAppAuth> | null = null;

function isAppAuthConfigured(): boolean {
  return !!(
    config.secrets.GITHUB_APP_PRIVATE_KEY &&
    config.secrets.GITHUB_APP_CLIENT_ID &&
    config.secrets.GITHUB_APP_INSTALLATION_ID
  );
}

function getAuth(): ReturnType<typeof createAppAuth> {
  if (!authInstance) {
    authInstance = createAppAuth({
      appId: config.secrets.GITHUB_APP_CLIENT_ID!,
      privateKey: config.secrets.GITHUB_APP_PRIVATE_KEY!,
      installationId: Number(config.secrets.GITHUB_APP_INSTALLATION_ID),
    });
  }
  return authInstance;
}

/** Refresh buffer — matches agent-service's REFRESH_BUFFER_MS */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Generate a GitHub token for agent use.
 *
 * If GitHub App credentials are configured, generates an installation token (expires in 1 hour).
 * Returns the cached token unless it expires within 5 minutes, in which case a fresh one is
 * requested from GitHub. This deduplicates refresh calls when multiple agents request at once.
 *
 * Otherwise, returns the static GITHUB_TOKEN PAT (no expiry, no refresh needed).
 */
export async function generateGitHubToken(): Promise<{
  token: string;
  expiresAt: string;
}> {
  if (config.dryRun) {
    return {
      token: "ghs_dry_run_installation_token",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    };
  }

  // GitHub App auth: generate a fresh installation token
  if (isAppAuthConfigured()) {
    const auth = getAuth();
    // Get the cached token first
    const cached = await auth({ type: "installation" });
    const expiresMs = new Date(cached.expiresAt!).getTime();
    const needsRefresh = expiresMs - Date.now() < REFRESH_BUFFER_MS;

    if (needsRefresh) {
      const fresh = await auth({ type: "installation", refresh: true });
      console.log(
        `[github:token] Refreshed installation token (expires ${fresh.expiresAt})`,
      );
      return { token: fresh.token, expiresAt: fresh.expiresAt! };
    }

    console.log(
      `[github:token] Returning cached installation token (expires ${cached.expiresAt})`,
    );
    return { token: cached.token, expiresAt: cached.expiresAt! };
  }

  // Static PAT: no expiry, no refresh
  if (config.secrets.GITHUB_TOKEN) {
    console.log("[github:token] Using static GitHub PAT (no expiry)");
    return { token: config.secrets.GITHUB_TOKEN, expiresAt: "" };
  }

  throw new Error(
    "No GitHub credentials configured. Set either GITHUB_APP_PRIVATE_KEY + GITHUB_APP_CLIENT_ID + GITHUB_APP_INSTALLATION_ID, or GITHUB_TOKEN.",
  );
}
