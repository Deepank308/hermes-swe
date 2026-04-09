import { AgentActivitySignal } from "@linear/sdk";
import type { AgentSessionEventWebhookPayload } from "@linear/sdk";
import * as sessionStore from "./session-store.js";
import { sessionManager } from "./session-manager.js";

// --- Session Created ---

export async function handleSessionCreated(
  event: AgentSessionEventWebhookPayload,
): Promise<void> {
  const agentSessionId = event.agentSession.id;
  const issueId = event.agentSession.issueId;
  const organizationId = event.organizationId;

  if (!issueId) {
    console.warn("[webhook:handle] Session created event has no issueId, ignoring");
    return;
  }

  const webhookIssue = event.agentSession.issue;

  console.log(
    `[webhook:handle] Session created: ${agentSessionId} for ${webhookIssue?.identifier ?? "unknown"} — ${webhookIssue?.title ?? "Untitled"} (org: ${organizationId})`,
  );

  // Idempotency: skip if we've already seen this session (webhook retry)
  const existing = await sessionStore.get(agentSessionId);
  if (existing) {
    console.log(
      `[webhook:handle] Session ${agentSessionId} already exists (status: ${existing.status}), skipping`,
    );
    return;
  }

  await sessionManager.startSession({
    agentSessionId,
    issueId,
    organizationId,
    identifier: webhookIssue?.identifier ?? "unknown",
    title: webhookIssue?.title ?? "Untitled",
    description: webhookIssue?.description ?? "",
    url: webhookIssue?.url ?? "",
    teamId: webhookIssue?.teamId ?? "",
    agentSessionUrl: event.agentSession.url ?? undefined,
    promptContext: event.promptContext,
    creatorEmail: event.agentSession.creator?.email,
  });
}

// --- Session Prompted ---

export async function handleSessionPrompted(
  event: AgentSessionEventWebhookPayload,
): Promise<void> {
  const agentSessionId = event.agentSession.id;
  const activity = event.agentActivity;

  if (!activity) {
    console.warn("[webhook:handle] Prompted event has no agentActivity, ignoring");
    return;
  }

  const session = await sessionStore.get(agentSessionId);

  // Stop signal
  if (activity.signal === AgentActivitySignal.Stop) {
    if (session?.status === "running" && session.privateIp) {
      await sessionManager.stopAgent(session);
    } else if (
      session?.status === "queued" ||
      session?.status === "provisioning"
    ) {
      await sessionManager.cancelSession(session);
    }
    return;
  }

  const content = activity.content as { body?: string };
  const body = content.body ?? "";
  const authorName = activity.user?.name ?? activity.userId ?? "unknown";

  // If session is running, forward the message to the live instance
  if (session?.privateIp && session.status === "running") {
    await sessionManager.forwardMessage(
      session,
      agentSessionId,
      body,
      authorName,
    );
    return;
  }

  // Session is completed/failed/stopped — resume by spinning up a new instance
  if (
    session &&
    (session.status === "completed" ||
      session.status === "failed" ||
      session.status === "stopped")
  ) {
    // plan is present in webhook data but not in SDK types
    const agentSession = event.agentSession as typeof event.agentSession & {
      plan?: { entries?: Array<{ content: string; status: string }> };
    };
    const planEntries = agentSession.plan?.entries;
    await sessionManager.resumeSession(
      session,
      agentSessionId,
      body,
      authorName,
      planEntries,
    );
    return;
  }

  console.warn(
    `[webhook:handle] Cannot handle prompt for session ${agentSessionId} (status: ${session?.status ?? "unknown"})`,
  );
}
