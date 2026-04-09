import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "./config.js";

const TOKEN_URL = "https://api.linear.app/oauth/token";
const LINEAR_API_URL = "https://api.linear.app/graphql";
const TOKEN_FILE = resolve(import.meta.dirname, "../.linear-tokens.json");

interface StoredToken {
  accessToken: string;
  refreshToken?: string;
  /** ISO timestamp when the access token expires */
  expiresAt: string;
  /** Human-readable organization name (e.g. "Acme Inc") */
  organizationName?: string;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
}

/** Buffer before actual expiry to avoid using a nearly-expired token */
const EXPIRY_BUFFER_MS = 60 * 60 * 1000; // 1 hour

/** In-memory cache: organizationId → StoredToken */
const cached = new Map<string, StoredToken>();

function loadAllTokens(): Record<string, StoredToken> {
  try {
    const raw = JSON.parse(readFileSync(TOKEN_FILE, "utf-8"));
    // Backward compat: old format has accessToken at root (single-token file)
    if (raw.accessToken && raw.expiresAt) {
      console.warn(
        "[linear:token] Old single-token format detected in .linear-tokens.json — ignoring. Re-install the app via /oauth/install for each org.",
      );
      return {};
    }
    return raw as Record<string, StoredToken>;
  } catch {
    // file missing or corrupt
  }
  return {};
}

function saveAllTokens(tokens: Record<string, StoredToken>): void {
  try {
    writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), {
      mode: 0o600,
    });
  } catch (err) {
    console.warn(
      "[linear:token] Failed to persist tokens:",
      err instanceof Error ? err.message : err,
    );
  }
}

function saveToken(organizationId: string, token: StoredToken): void {
  const all = loadAllTokens();
  all[organizationId] = token;
  saveAllTokens(all);
}

function isExpired(stored: StoredToken): boolean {
  return Date.now() >= new Date(stored.expiresAt).getTime() - EXPIRY_BUFFER_MS;
}

function toStoredToken(data: TokenResponse): StoredToken {
  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt,
  };
}

interface OrganizationInfo {
  id: string;
  name: string;
}

/**
 * Query the Linear API to get the organization ID and name for a given access token.
 */
async function fetchOrganizationInfo(accessToken: string): Promise<OrganizationInfo> {
  const resp = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: accessToken,
    },
    body: JSON.stringify({
      query: "{ viewer { organization { id name } } }",
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `Failed to fetch organization info (${resp.status}): ${body}`,
    );
  }

  const data = (await resp.json()) as {
    data?: { viewer?: { organization?: { id?: string; name?: string } } };
  };
  const org = data.data?.viewer?.organization;
  if (!org?.id) {
    throw new Error("Linear API did not return an organization ID");
  }
  return { id: org.id, name: org.name ?? "Unknown" };
}

/**
 * Exchange an authorization code for an access token (completes app installation).
 * Queries the Linear API to discover which organization authorized the app.
 */
export async function exchangeCode(code: string): Promise<void> {
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.secrets.LINEAR_CLIENT_ID,
      client_secret: config.secrets.LINEAR_CLIENT_SECRET,
      redirect_uri: config.linearRedirectUri,
      code,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Linear code exchange failed (${resp.status}): ${body}`);
  }

  const data = (await resp.json()) as TokenResponse;
  const token = toStoredToken(data);

  // Discover which organization this token belongs to
  const org = await fetchOrganizationInfo(token.accessToken);
  token.organizationName = org.name;

  cached.set(org.id, token);
  saveToken(org.id, token);
  console.log(
    `[linear:token] Code exchanged for org "${org.name}" (${org.id}), token expires ${token.expiresAt}` +
      (token.refreshToken ? " (refresh token stored)" : " (no refresh token)"),
  );
}

/**
 * Use the stored refresh token to get a new access token.
 */
async function refreshToken(
  organizationId: string,
  refreshTok: string,
): Promise<StoredToken> {
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: config.secrets.LINEAR_CLIENT_ID,
      client_secret: config.secrets.LINEAR_CLIENT_SECRET,
      refresh_token: refreshTok,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Linear token refresh failed (${resp.status}): ${body}`);
  }

  const data = (await resp.json()) as TokenResponse;
  const stored = toStoredToken(data);
  // Keep the existing refresh token if the response doesn't include a new one
  if (!stored.refreshToken) {
    stored.refreshToken = refreshTok;
  }
  // Preserve organizationName from the previous token
  const previous = cached.get(organizationId) ?? loadAllTokens()[organizationId];
  if (previous?.organizationName) {
    stored.organizationName = previous.organizationName;
  }
  cached.set(organizationId, stored);
  saveToken(organizationId, stored);
  console.log(
    `[linear:token] Token refreshed for org ${organizationId} (expires ${stored.expiresAt})`,
  );
  return stored;
}

/**
 * Get a Linear access token for a specific organization.
 * Loads from disk or refreshes if expired.
 * Requires initial installation via /oauth/install.
 */
export async function getLinearToken(
  organizationId: string,
): Promise<string> {
  // Check in-memory cache first
  const mem = cached.get(organizationId);
  if (mem && !isExpired(mem)) return mem.accessToken;

  // Try loading from disk
  const all = loadAllTokens();
  const stored = all[organizationId];
  if (stored && !isExpired(stored)) {
    cached.set(organizationId, stored);
    console.log(
      `[linear:token] Loaded token for org ${organizationId} from disk (expires ${stored.expiresAt})`,
    );
    return stored.accessToken;
  }

  // Token expired — try refresh
  const tokenToRefresh = stored ?? mem;
  if (tokenToRefresh?.refreshToken) {
    const refreshed = await refreshToken(
      organizationId,
      tokenToRefresh.refreshToken,
    );
    return refreshed.accessToken;
  }

  throw new Error(
    `No valid Linear token found for org ${organizationId}. Install the app via /oauth/install`,
  );
}
