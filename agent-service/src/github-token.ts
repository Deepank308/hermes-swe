import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Single source of truth for GitHub credentials.
 * Both gh CLI (natively) and git (via `gh auth git-credential`) read from this file.
 */
const GH_HOSTS_FILE = "/home/ubuntu/.config/gh/hosts.yml";
/** Refresh 2 minutes before expiry */
const REFRESH_BUFFER_MS = 2 * 60 * 1000;

let refreshTimer: NodeJS.Timeout | null = null;

/**
 * Update the GitHub token on disk. Writes to gh CLI hosts.yml which serves
 * as the single credential source for both gh CLI and git (via gh auth git-credential).
 */
export function updateGitHubToken(token: string): void {
  const hostsContent = [
    "github.com:",
    `    oauth_token: ${token}`,
    "    git_protocol: https",
    "",
  ].join("\n");

  mkdirSync(dirname(GH_HOSTS_FILE), { recursive: true });
  writeFileSync(GH_HOSTS_FILE, hostsContent, { mode: 0o600 });

  console.log("[github-token] Token updated in hosts.yml");
}

/**
 * Schedule a GitHub token refresh. Calls the orchestrator's /github-refresh-token
 * endpoint before the current token expires, then updates hosts.yml and
 * reschedules the next refresh.
 */
export function scheduleGitHubTokenRefresh(
  expiresAt: string,
  orchestratorUrl: string,
): void {
  clearGitHubTokenRefresh();

  const expiresMs = new Date(expiresAt).getTime();
  const delayMs = Math.max(expiresMs - Date.now() - REFRESH_BUFFER_MS, 0);

  console.log(
    `[github-token] Scheduling refresh in ${Math.round(delayMs / 1000)}s (expires ${expiresAt})`,
  );

  refreshTimer = setTimeout(async () => {
    try {
      const resp = await fetch(`${orchestratorUrl}/github-refresh-token`, {
        signal: AbortSignal.timeout(10_000),
      });

      if (!resp.ok) {
        const text = await resp.text();
        const retryable =
          resp.status >= 500 || resp.status === 429 || resp.status === 408;
        console.error(
          `[github-token] Refresh failed (${resp.status}): ${text}`,
        );
        if (retryable) {
          scheduleGitHubTokenRefresh(
            new Date(Date.now() + REFRESH_BUFFER_MS + 60_000).toISOString(),
            orchestratorUrl,
          );
        }
        return;
      }

      const body = (await resp.json()) as {
        ok: boolean;
        data?: { token: string; expiresAt: string };
      };
      if (!body.ok || !body.data) {
        console.error("[github-token] Invalid response from orchestrator");
        return;
      }

      updateGitHubToken(body.data.token);
      console.log(
        `[github-token] Refreshed token (new expiry: ${body.data.expiresAt})`,
      );

      // Schedule next refresh
      scheduleGitHubTokenRefresh(body.data.expiresAt, orchestratorUrl);
    } catch (err) {
      // Network error / timeout — retry in 60 seconds
      console.error(
        "[github-token] Failed to refresh token:",
        err instanceof Error ? err.message : err,
      );
      scheduleGitHubTokenRefresh(
        new Date(Date.now() + REFRESH_BUFFER_MS + 60_000).toISOString(),
        orchestratorUrl,
      );
    }
  }, delayMs);
  refreshTimer.unref();
}

export function clearGitHubTokenRefresh(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}
