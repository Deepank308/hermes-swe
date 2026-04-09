import {
  LinearClient,
  AgentActivityType,
  AgentActivitySignal,
} from "@linear/sdk";

type AgentActivityCreateInput = Parameters<
  LinearClient["createAgentActivity"]
>[0];
import { ClaudeMessageFormatter } from "cyrus-claude-runner";
import type { PreviewEntry } from "./types.js";

const PR_URL_RE = /https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/;

function buildWorkspacePrefixRe(workspaceDir: string): RegExp {
  return new RegExp(
    workspaceDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/",
    "g",
  );
}

const PLAN_STATUS: Record<string, string> = {
  pending: "pending",
  in_progress: "inProgress",
  completed: "completed",
  deleted: "canceled",
};

export class LinearReporter {
  private readonly linearClient: LinearClient;
  private readonly formatter = new ClaudeMessageFormatter();
  /** Strips the workspace directory prefix from paths shown in Linear activity. */
  private readonly workspacePrefixRe: RegExp;
  /** Agent session IDs that Linear has rejected — skip future calls for these. */
  private readonly deadSessions = new Set<string>();
  /** Agent session IDs where we already attached a PR URL. */
  private readonly prAttached = new Set<string>();
  /** Stored PR URL per session (for completion callback). */
  private readonly prUrls = new Map<string, string>();
  /** Stored preview entries per session — keyed by URL for dedup. */
  private readonly previewUrls = new Map<string, Map<string, PreviewEntry>>();
  /** Set when a `gh pr create` Bash command is detected — enables PR URL capture. */
  private prCreatePending = false;
  /** Plan steps keyed by agentSessionId — synced to Linear Agent Plans. */
  private readonly plans = new Map<
    string,
    Array<{ content: string; status: string }>
  >();

  constructor(linearClient: LinearClient, workspaceDir: string) {
    this.linearClient = linearClient;
    this.workspacePrefixRe = buildWorkspacePrefixRe(workspaceDir);
  }

  async reportStarted(agentSessionId: string): Promise<void> {
    await this.createActivity(
      agentSessionId,
      {
        type: AgentActivityType.Thought,
        body: `Starting Claude Code...`,
      },
      true,
    );
  }

  async reportCompletion(
    agentSessionId: string,
    summary: string,
  ): Promise<void> {
    await this.createActivity(agentSessionId, {
      type: AgentActivityType.Response,
      body: summary,
    });
    await this.tryAttachPrUrl(agentSessionId, summary);
  }

  async reportError(agentSessionId: string, error: string): Promise<void> {
    await this.createActivity(agentSessionId, {
      type: AgentActivityType.Error,
      body: error,
    });
  }

  async reportAction(
    agentSessionId: string,
    toolName: string,
    input?: unknown,
  ): Promise<void> {
    // Sync TaskCreate / TaskUpdate to Linear Agent Plans
    if (toolName === "TaskCreate" && input && typeof input === "object") {
      const obj = input as Record<string, unknown>;
      const subject = String(obj.subject ?? "");
      if (subject) {
        const plan = this.plans.get(agentSessionId) ?? [];
        plan.push({ content: subject, status: "pending" });
        this.plans.set(agentSessionId, plan);
        this.syncPlan(agentSessionId);
      }
    }

    if (toolName === "TaskUpdate" && input && typeof input === "object") {
      const obj = input as Record<string, unknown>;
      const taskId = String(obj.taskId ?? "");
      const plan = this.plans.get(agentSessionId);
      if (plan && taskId) {
        const idx = parseInt(taskId, 10) - 1;
        if (idx >= 0 && idx < plan.length) {
          if (typeof obj.status === "string" && PLAN_STATUS[obj.status]) {
            plan[idx].status = PLAN_STATUS[obj.status];
          }
          if (typeof obj.subject === "string") {
            plan[idx].content = obj.subject;
          }
          this.syncPlan(agentSessionId);
        }
      }
    }

    // Detect `gh pr create` so we only attach PR URLs that were actually created
    if (
      toolName.toLowerCase() === "bash" &&
      input &&
      typeof input === "object"
    ) {
      const obj = input as Record<string, unknown>;
      const cmd = String(obj.command ?? obj.description ?? "");
      if (cmd.includes("gh pr create") || cmd.includes("git push")) {
        this.prCreatePending = true;
      }
    }

    const action = this.formatter
      .formatToolActionName(toolName, input, false)
      .replace(this.workspacePrefixRe, "");

    let parameter: string;
    if (toolName === "Skill" && input && typeof input === "object") {
      const obj = input as Record<string, unknown>;
      const skill = String(obj.skill ?? "");
      parameter = String(`/${skill}`);
    } else if (toolName === "EnterPlanMode") {
      parameter = "";
    } else {
      parameter = this.formatter
        .formatToolParameter(toolName, input)
        .replace(this.workspacePrefixRe, "");
    }

    await this.createActivity(agentSessionId, {
      type: AgentActivityType.Action,
      action,
      parameter,
    });
  }

  async reportElicitation(
    agentSessionId: string,
    body: string,
    options?: string[],
  ): Promise<void> {
    await this.createActivity(
      agentSessionId,
      {
        type: AgentActivityType.Elicitation,
        body,
      },
      false,
      options?.length
        ? {
            signal: AgentActivitySignal.Select,
            signalMetadata: {
              options: options.map((value) => ({ value })),
            },
          }
        : undefined,
    );
  }

  async reportThought(agentSessionId: string, text: string): Promise<void> {
    await this.createActivity(agentSessionId, {
      type: AgentActivityType.Thought,
      body: text,
    });
    await this.tryAttachPrUrl(agentSessionId, text);
  }

  /** Attach a preview URL to the Linear agent session. Additive — multiple URLs supported. */
  async attachPreviewUrl(
    agentSessionId: string,
    previewUrl: string,
    label: string,
  ): Promise<void> {
    if (this.deadSessions.has(agentSessionId)) return;

    const existing =
      this.previewUrls.get(agentSessionId) ??
      new Map<string, PreviewEntry>();
    if (existing.has(previewUrl)) return; // already attached, skip duplicate

    const entry: PreviewEntry = { url: previewUrl, label };
    existing.set(previewUrl, entry);
    this.previewUrls.set(agentSessionId, existing);
    try {
      await this.linearClient.agentSessionUpdateExternalUrl(agentSessionId, {
        addedExternalUrls: [{ url: previewUrl, label }],
      });
      console.log(
        `[linear-reporter] Attached preview URL to session: ${previewUrl} (${label})`,
      );
    } catch (err) {
      console.warn(
        "[linear-reporter] Failed to attach preview URL:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  /** Seed previous preview entries (e.g. from orchestrator on resume) so they're preserved. */
  setPreviousPreviewUrls(
    agentSessionId: string,
    entries: PreviewEntry[],
  ): void {
    const map = new Map<string, PreviewEntry>();
    for (const entry of entries) map.set(entry.url, entry);
    this.previewUrls.set(agentSessionId, map);
  }

  /** Scan text for a GitHub PR URL and attach it to the Linear session (once). */
  private async tryAttachPrUrl(
    agentSessionId: string,
    text: string,
  ): Promise<void> {
    if (
      !this.prCreatePending ||
      this.prAttached.has(agentSessionId) ||
      this.deadSessions.has(agentSessionId)
    ) {
      return;
    }

    const match = text.match(PR_URL_RE);
    if (!match) return;

    this.prCreatePending = false;
    this.prAttached.add(agentSessionId);
    this.prUrls.set(agentSessionId, match[0]);
    try {
      const result = await this.linearClient.agentSessionUpdateExternalUrl(
        agentSessionId,
        {
          addedExternalUrls: [{ url: match[0], label: "Pull Request" }],
        },
      );
      console.log(`[linear-reporter] Attached PR to session: ${match[0]}`);
      console.log(`[linear-reporter] Result: ${JSON.stringify(result)}`);
    } catch (err) {
      console.warn(
        "[linear-reporter] Failed to attach PR URL:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  /** Restore plan from a previous session (e.g. after resume on a fresh instance). */
  restorePlan(
    agentSessionId: string,
    entries: Array<{ content: string; status: string }>,
  ): void {
    this.plans.set(
      agentSessionId,
      entries.map((e) => ({ content: e.content, status: e.status })),
    );
    console.log(
      `[linear-reporter] Restored plan with ${entries.length} steps for session ${agentSessionId}`,
    );
  }

  /** Fire-and-forget sync of plan steps to Linear Agent Plans. */
  private syncPlan(agentSessionId: string): void {
    const plan = this.plans.get(agentSessionId);
    if (!plan || this.deadSessions.has(agentSessionId)) return;

    this.linearClient
      .updateAgentSession(agentSessionId, { plan: [...plan] })
      .catch((err) => {
        console.warn(
          "[linear-reporter] Failed to sync plan:",
          err instanceof Error ? err.message : err,
        );
      });
  }

  /** Get the PR URL attached for this session, if any. */
  getPrUrl(agentSessionId: string): string | undefined {
    return this.prUrls.get(agentSessionId);
  }

  /** Get all preview entries attached for this session. */
  getPreviewUrls(agentSessionId: string): PreviewEntry[] {
    const map = this.previewUrls.get(agentSessionId);
    return map ? [...map.values()] : [];
  }

  async postComment(issueId: string, body: string): Promise<void> {
    await this.linearClient.createComment({ issueId, body });
  }

  private async createActivity(
    agentSessionId: string,
    content: Record<string, unknown>,
    ephemeral = false,
    extra?: Pick<AgentActivityCreateInput, "signal" | "signalMetadata">,
  ): Promise<void> {
    if (this.deadSessions.has(agentSessionId)) return;

    const input: AgentActivityCreateInput = {
      agentSessionId,
      content,
      ...(ephemeral && { ephemeral }),
      ...extra,
    };

    const type = content.type;
    const maxRetries = type === AgentActivityType.Response ? 3 : 1;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await this.linearClient.createAgentActivity(input);
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        // Permanent failure — stop reporting for this session entirely
        if (message.includes("Entity not found: AgentSession")) {
          console.warn(
            `[linear-reporter] Agent session ${agentSessionId} not found in Linear — disabling reporting for this session`,
          );
          this.deadSessions.add(agentSessionId);
          return;
        }

        // Transient failure — retry with backoff
        if (attempt < maxRetries - 1 && isTransient(err)) {
          const delayMs = 1000 * 2 ** attempt; // 1s, 2s, 4s
          console.warn(
            `[linear-reporter] Transient error (attempt ${attempt + 1}/${maxRetries}), retrying in ${delayMs}ms: ${message}`,
          );
          await sleep(delayMs);
          continue;
        }

        console.error("[linear-reporter] Failed to post activity:", err);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Check if an error is transient (network timeout, connection reset, etc.) */
function isTransient(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const raw = (err as { raw?: Error })?.raw;
  const cause = raw?.cause ?? (err as { cause?: Error })?.cause;
  const causeCode = (cause as { code?: string })?.code;

  return (
    causeCode === "ETIMEDOUT" ||
    causeCode === "ECONNRESET" ||
    causeCode === "ECONNREFUSED" ||
    message.includes("fetch failed") ||
    message.includes("Fetch failed") ||
    message.includes("ETIMEDOUT") ||
    message.includes("socket hang up")
  );
}
