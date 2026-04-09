import { config } from "./config.js";
import * as sessionStore from "./session-store.js";

const SLACK_API_BASE = "https://slack.com/api";

/** In-memory cache: email → Slack user ID + DM channel ID */
interface SlackUserCache {
  dmChannelId: string;
  slackUserId: string;
}
const slackUserCache = new Map<string, SlackUserCache>();

/**
 * Post a message to the session creator's Slack DM, threaded by agentSessionId.
 * Falls back to the public channel if DM resolution fails.
 *
 * First message for a session creates the thread; subsequent messages reply in it.
 * thread_ts is persisted in the session store so threads survive restarts.
 */
export async function notifySlack(
  agentSessionId: string,
  message: string,
  { mention = false }: { mention?: boolean } = {},
): Promise<void> {
  const slackBotToken = config.secrets.SLACK_BOT_TOKEN;
  const { slackChannelId } = config;
  if (!slackBotToken) return;

  const session = await sessionStore.get(agentSessionId);
  const threadTs = session?.slackThreadTs;
  const issueIdentifier = session?.issueIdentifier;
  const issueTitle = session?.issueTitle;
  const url = session?.agentSessionUrl ?? session?.url;

  // Resolve DM channel for session creator, fall back to public channel
  const slackUser = await resolveDmChannel(
    agentSessionId,
    session?.creatorEmail,
    session?.slackDmChannelId,
    session?.slackUserId,
    slackBotToken,
  );

  const targetChannel = slackUser?.dmChannelId;
  const targetUserId = slackUser?.slackUserId;

  // If no DM channel and no public channel, nothing to do
  if (!targetChannel && !slackChannelId) return;

  const mentionPrefix =
    mention && session?.slackUserId ? `<@${session.slackUserId}> ` : "";
  const prefix = threadTs
    ? ""
    : `<${url}|${issueIdentifier}: ${issueTitle}> — `;

  const channel = targetChannel ?? slackChannelId;

  try {
    const resp = await fetch(`${SLACK_API_BASE}/chat.postMessage`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${slackBotToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel,
        text: `${mentionPrefix}${prefix}${message}`,
        ...(threadTs && { thread_ts: threadTs }),
      }),
    });

    const data = (await resp.json()) as {
      ok: boolean;
      ts?: string;
      error?: string;
    };

    if (!data.ok) {
      console.warn(`[slack:notify] API error: ${data.error}`);
      return;
    }

    // Persist the ts of the first message as the thread parent
    if (!threadTs && data.ts) {
      await sessionStore.update(agentSessionId, { slackThreadTs: data.ts });
    }
  } catch (err) {
    console.warn(
      "[slack:notify] Notification failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Resolve the Slack DM channel for the session creator.
 *
 * Resolution chain:
 * 1. Already cached in session record → use it
 * 2. In-memory cache (keyed by email) → use it
 * 3. Creator email → Slack API (lookup by email) → Slack API (open DM)
 *
 * Returns undefined if resolution fails (caller should fall back to public channel).
 */
async function resolveDmChannel(
  agentSessionId: string,
  creatorEmail: string | undefined,
  storedDmChannelId: string | undefined,
  storedSlackUserId: string | undefined,
  slackBotToken: string,
): Promise<SlackUserCache | undefined> {
  // 1. Already stored in session record
  if (storedDmChannelId && storedSlackUserId)
    return { dmChannelId: storedDmChannelId, slackUserId: storedSlackUserId };

  if (!creatorEmail) return undefined;

  // 2. In-memory cache
  const cached = slackUserCache.get(creatorEmail);
  if (cached) {
    // Persist to session record for thread continuity across restarts
    await sessionStore
      .update(agentSessionId, {
        slackDmChannelId: cached.dmChannelId,
        slackUserId: cached.slackUserId,
      })
      .catch(() => {});
    return cached;
  }

  // 3. Full resolution: email → Slack user → DM channel
  try {
    const slackUserId = await lookupSlackUserByEmail(
      creatorEmail,
      slackBotToken,
    );
    if (!slackUserId) {
      console.warn(`[slack:dm] No Slack user found for email ${creatorEmail}`);
      return undefined;
    }

    const dmChannelId = await openDmChannel(slackUserId, slackBotToken);
    if (!dmChannelId) {
      console.warn(
        `[slack:dm] Failed to open DM channel for Slack user ${slackUserId}`,
      );
      return undefined;
    }

    // Cache in memory and persist to session
    slackUserCache.set(creatorEmail, { dmChannelId, slackUserId });
    await sessionStore
      .update(agentSessionId, { slackDmChannelId: dmChannelId, slackUserId })
      .catch(() => {});

    console.log(
      `[slack:dm] Resolved DM channel for ${creatorEmail} → ${dmChannelId}`,
    );
    return { dmChannelId, slackUserId };
  } catch (err) {
    console.warn(
      "[slack:dm] DM resolution failed, falling back to public channel:",
      err instanceof Error ? err.message : err,
    );
    return undefined;
  }
}

/** Look up a Slack user by email address. Requires users:read.email scope. */
async function lookupSlackUserByEmail(
  email: string,
  token: string,
): Promise<string | undefined> {
  const resp = await fetch(
    `${SLACK_API_BASE}/users.lookupByEmail?email=${encodeURIComponent(email)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  const data = (await resp.json()) as {
    ok: boolean;
    user?: { id: string };
    error?: string;
  };
  if (!data.ok) {
    console.warn(`[slack:dm] users.lookupByEmail failed: ${data.error}`);
    return undefined;
  }
  return data.user?.id;
}

/** Open (or retrieve) a DM channel with a Slack user. Requires im:write scope. */
async function openDmChannel(
  slackUserId: string,
  token: string,
): Promise<string | undefined> {
  const resp = await fetch(`${SLACK_API_BASE}/conversations.open`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ users: slackUserId }),
  });
  const data = (await resp.json()) as {
    ok: boolean;
    channel?: { id: string };
    error?: string;
  };
  if (!data.ok) {
    console.warn(`[slack:dm] conversations.open failed: ${data.error}`);
    return undefined;
  }
  return data.channel?.id;
}
