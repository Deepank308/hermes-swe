import { LinearClient, AgentActivityType } from "@linear/sdk";
import { getLinearToken } from "./linear-token.js";

/** Per-org cache of LinearClient, keyed by organizationId */
const clientCache = new Map<
  string,
  { client: LinearClient; token: string }
>();

export async function getLinearClient(
  organizationId: string,
): Promise<LinearClient> {
  const token = await getLinearToken(organizationId);
  const entry = clientCache.get(organizationId);
  if (entry && entry.token === token) return entry.client;

  const client = new LinearClient({ accessToken: token });
  clientCache.set(organizationId, { client, token });
  return client;
}

export async function postActivity(
  agentSessionId: string,
  body: string,
  organizationId: string,
  {
    type = AgentActivityType.Thought,
    ephemeral = false,
  }: { type?: AgentActivityType; ephemeral?: boolean } = {},
): Promise<void> {
  try {
    const client = await getLinearClient(organizationId);
    await client.createAgentActivity({
      agentSessionId,
      content: {
        type,
        body,
      },
      ephemeral,
    });
  } catch (err) {
    console.warn(
      "[linear:activity] Failed to post activity:",
      err instanceof Error ? err.message : err,
    );
  }
}
