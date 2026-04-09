import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ClaudeRunner, getAllTools } from "cyrus-claude-runner";
import type {
  ClaudeRunnerConfig,
  SDKMessage,
  HookInput,
  HookJSONOutput,
} from "cyrus-claude-runner";
import type { AskUserQuestionInput, AskUserQuestionResult } from "cyrus-core";
import { SessionState } from "./types.js";
import type { RunRequest } from "./types.js";
import type { LinearReporter } from "./linear-reporter.js";
import type { SessionStore } from "./session-store.js";

/** How long to wait for a user response to an elicitation before timing out. */
const ELICITATION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

export interface SessionManagerConfig {
  workspaceDir: string;
  logsDir: string;
  claudeProjectsDir: string;
  model: string;
  maxTurns: number;
  systemPrompt: string;
  reporter: LinearReporter;
  sessionStore: SessionStore;
  /** Base URL of the orchestrator (e.g. http://localhost:3002) */
  orchestratorUrl?: string;
}

export class SessionManager {
  private state = SessionState.Idle;
  private runner: ClaudeRunner | null = null;
  private agentSessionId: string | null = null;
  private _issueId: string | null = null;
  private _claudeSessionId: string | null = null;
  private messageCount = 0;
  private lastResultMessage: Record<string, unknown> | null = null;
  /** Buffered assistant text — held until we know if it's the final message. */
  private pendingThought: { agentSessionId: string; content: string } | null =
    null;
  /** Pending elicitation — set when Claude asks a question and we're waiting for a user reply. */
  private pendingElicitation: {
    questionText: string;
    resolve: (result: AskUserQuestionResult) => void;
  } | null = null;

  private readonly config: SessionManagerConfig;

  constructor(config: SessionManagerConfig) {
    this.config = config;
  }

  async start(request: RunRequest): Promise<void> {
    if (this.state !== SessionState.Idle) {
      throw new Error(`Cannot start session: current state is ${this.state}`);
    }

    this.agentSessionId = request.agentSessionId;
    this._issueId = request.issueId;

    const resumeSessionId = request.resumeAgentSessionId
      ? (request.claudeSessionId ??
        this.config.sessionStore.getClaudeSessionId(
          request.resumeAgentSessionId,
        ))
      : undefined;

    // Restore plan from previous session so LinearReporter can continue updating it
    if (request.plan?.length) {
      this.config.reporter.restorePlan(request.agentSessionId, request.plan);
    }

    // Seed previous preview URLs so they're preserved across resume
    if (request.previousPreviewUrls?.length) {
      this.config.reporter.setPreviousPreviewUrls(
        request.agentSessionId,
        request.previousPreviewUrls,
      );
    }

    this.launchRunner(request.agentSessionId, request.prompt, resumeSessionId);

    console.log(`[session] Running for issue ${request.issueId}`);
    if (!request.resumeAgentSessionId) {
      await this.config.reporter.reportStarted(request.agentSessionId);
    }
  }

  /**
   * Resume a completed/failed session with a follow-up message.
   * Looks up the Claude session ID from the store and starts a new runner.
   */
  async resume(agentSessionId: string, message: string): Promise<void> {
    if (
      this.state !== SessionState.Idle &&
      this.state !== SessionState.Completed &&
      this.state !== SessionState.Failed
    ) {
      throw new Error(`Cannot resume session: current state is ${this.state}`);
    }

    const resumeSessionId =
      this.config.sessionStore.getClaudeSessionId(agentSessionId);
    if (!resumeSessionId) {
      throw new Error(
        `No Claude session found for agent session ${agentSessionId}`,
      );
    }

    this.launchRunner(agentSessionId, message, resumeSessionId);
    console.log(`[session] Resumed session ${agentSessionId}`);
  }

  /**
   * Shared runner setup for start() and resume().
   */
  private launchRunner(
    agentSessionId: string,
    prompt: string,
    resumeSessionId?: string,
  ): void {
    this.state = SessionState.Starting;
    this.messageCount = 0;
    this.lastResultMessage = null;
    this._claudeSessionId = null;
    this.pendingThought = null;
    this.pendingElicitation = null;

    const runnerConfig: ClaudeRunnerConfig = {
      workingDirectory: this.config.workspaceDir,
      cyrusHome: this.config.logsDir,
      appendSystemPrompt: this.config.systemPrompt,
      model: this.config.model,
      maxTurns: this.config.maxTurns,
      allowedTools: getAllTools(),
      ...(resumeSessionId && { resumeSessionId }),
      hooks: {
        PreToolUse: [
          {
            matcher: "Task",
            hooks: [
              async (input: HookInput): Promise<HookJSONOutput> => {
                const toolInput = (
                  input as { tool_input?: Record<string, unknown> }
                ).tool_input;
                if (toolInput?.run_in_background) {
                  console.log(
                    "[session] Hook: forcing run_in_background=false on Task tool",
                  );
                  return {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse" as const,
                      updatedInput: { ...toolInput, run_in_background: false },
                      additionalContext:
                        "Running in foreground mode, background tasks are not allowed.",
                    },
                  };
                }
                return {};
              },
            ],
          },
        ],
        PostToolUse: [
          {
            matcher: "Bash",
            hooks: [
              // On git push: nudge Claude to use the /preview skill
              async (input: HookInput): Promise<HookJSONOutput> => {
                const toolInput = (
                  input as { tool_input?: Record<string, unknown> }
                ).tool_input;
                const command =
                  typeof toolInput?.command === "string"
                    ? toolInput.command
                    : "";
                if (/\bgit\s+push\b/.test(command)) {
                  const launchJsonPath = resolve(
                    this.config.workspaceDir,
                    ".claude/launch.json",
                  );
                  if (existsSync(launchJsonPath)) {
                    return {
                      hookSpecificOutput: {
                        hookEventName: "PostToolUse" as const,
                        additionalContext:
                          "You just pushed code. Launch a preview so the reviewer can see the changes. Use the /preview skill.",
                      },
                    };
                  }
                }
                return {};
              },
              // Auto-capture preview URLs from Bash output → attach to Linear
              async (input: HookInput): Promise<HookJSONOutput> => {
                const toolResponse = (
                  input as { tool_response?: unknown }
                ).tool_response;
                const responseText =
                  typeof toolResponse === "string"
                    ? toolResponse
                    : JSON.stringify(toolResponse ?? "");
                const previewDomain = process.env.PREVIEW_DOMAIN;
                if (previewDomain && this.agentSessionId) {
                  const escaped = previewDomain.replace(
                    /[.*+?^${}()|[\]\\]/g,
                    "\\$&",
                  );
                  // URL pattern: https://preview-{shortId}-{configName}.domain.com
                  const urlRe = new RegExp(
                    `https://preview-[a-zA-Z0-9]+-([a-zA-Z0-9._-]+)\\.${escaped}`,
                    "g",
                  );
                  for (const match of responseText.matchAll(urlRe)) {
                    const previewUrl = match[0];
                    const configName = match[1] ?? "Preview";
                    // Capitalize first letter for label
                    const label =
                      configName.charAt(0).toUpperCase() +
                      configName.slice(1);
                    console.log(
                      `[session] Auto-captured preview URL: ${previewUrl} (${label})`,
                    );
                    this.config.reporter
                      .attachPreviewUrl(
                        this.agentSessionId,
                        previewUrl,
                        label,
                      )
                      .catch(() => {});
                    this.notifyPreviewUrl(
                      this.agentSessionId,
                      previewUrl,
                      label,
                    );
                  }
                }
                return {};
              },
            ],
          },
        ],
      },
      // Providing onAskUserQuestion creates a canUseTool callback that
      // auto-approves ALL tools (including ExitPlanMode) except AskUserQuestion.
      // When Claude asks a question, we post it to Linear as an elicitation and wait for the user's reply.
      onAskUserQuestion: async (
        input: AskUserQuestionInput,
        _sessionId: string,
        signal: AbortSignal,
      ): Promise<AskUserQuestionResult> => {
        const question = input.questions[0];
        if (!question) {
          return { answered: false, message: "No question provided." };
        }

        const body = formatElicitation(question);
        const optionLabels = question.options.map(
          (o: { label: string }) => o.label,
        );
        console.log(
          `[session] Elicitation: posting question to Linear — "${question.question}"`,
        );

        try {
          await this.config.reporter.reportElicitation(
            agentSessionId,
            body,
            optionLabels,
          );
        } catch (err) {
          console.error(
            "[session] Failed to post elicitation to Linear:",
            err instanceof Error ? err.message : err,
          );
          return {
            answered: false,
            message:
              "Failed to reach the user. Use your best judgment to proceed.",
          };
        }

        // Notify orchestrator so it can send a Slack notification
        this.notifyWaitingForInput(agentSessionId, question.header).catch(
          () => {},
        );

        // Wait for the user's reply (delivered via addMessage → resolveElicitation)
        return new Promise<AskUserQuestionResult>((resolve) => {
          const timeout = setTimeout(() => {
            if (this.pendingElicitation) {
              this.pendingElicitation = null;
              console.log("[session] Elicitation timed out waiting for user");
              resolve({
                answered: false,
                message:
                  "The user did not respond in time. Use your best judgment to proceed.",
              });
            }
          }, ELICITATION_TIMEOUT_MS);

          this.pendingElicitation = {
            questionText: question.question,
            resolve: (result) => {
              clearTimeout(timeout);
              resolve(result);
            },
          };

          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timeout);
              if (this.pendingElicitation) {
                this.pendingElicitation = null;
                resolve({ answered: false, message: "Request cancelled." });
              }
            },
            { once: true },
          );
        });
      },
      onMessage: (message: SDKMessage) => {
        this.messageCount++;
        // Capture the real Claude API session ID from the `init` message
        // (not the runner's internal ID from earlier messages like `hook_started`)
        const msg = message as Record<string, unknown>;
        if (
          msg.subtype === "init" &&
          msg.session_id &&
          typeof msg.session_id === "string"
        ) {
          this._claudeSessionId = msg.session_id as string;
          this.config.sessionStore.save(
            agentSessionId,
            this._claudeSessionId,
            this._issueId ?? "",
          );
          this.reportClaudeSessionId(agentSessionId, this._claudeSessionId);
        }
        // Capture result messages for inspection in onComplete
        if ("type" in message && msg.type === "result") {
          this.lastResultMessage = message as Record<string, unknown>;
          console.log(
            `[session] Result message:`,
            JSON.stringify({
              subtype: this.lastResultMessage.subtype,
              duration_ms: this.lastResultMessage.duration_ms,
              total_cost_usd: this.lastResultMessage.total_cost_usd,
              num_turns: this.lastResultMessage.num_turns,
            }),
          );
        }
      },
      onComplete: async () => {
        // Skip if stop() already handled the completion
        if (
          this.state === SessionState.Stopping ||
          this.state === SessionState.Completed
        ) {
          console.log(`[session] onComplete ignored (state: ${this.state})`);
          return;
        }

        const result = this.lastResultMessage;
        const subtype = result?.subtype as string | undefined;
        const numTurns = result?.num_turns ?? "?";
        const cost =
          typeof result?.total_cost_usd === "number"
            ? `$${(result.total_cost_usd as number).toFixed(2)}`
            : "unknown";

        // Handle error subtypes from the SDK
        if (subtype && subtype !== "success") {
          this.flushPendingThought();
          this.state = SessionState.Failed;
          const errorMsg =
            subtype === "error_max_turns"
              ? `Session hit max turns limit (${numTurns} turns, cost: ${cost}). Increase MAX_TURNS or simplify the task.`
              : `Session ended with error: ${subtype} (${numTurns} turns, cost: ${cost})`;
          console.error(`[session] ${errorMsg}`);
          await this.config.reporter.reportError(agentSessionId, errorMsg);
          await this.notifyCompletion(agentSessionId, "failed", errorMsg);
          return;
        }

        this.state = SessionState.Completed;
        console.log(
          `[session] Completed after ${this.messageCount} messages (${numTurns} turns, cost: ${cost})`,
        );

        // Send the final text as a Response (not Thought)
        const finalText =
          (typeof result?.result === "string"
            ? (result.result as string)
            : null) ?? this.pendingThought?.content;
        this.pendingThought = null;
        const summary = finalText ? `${finalText}` : `Session completed`;
        await this.config.reporter.reportCompletion(agentSessionId, summary);
        await this.notifyCompletion(agentSessionId, "completed");
      },
      onError: async (error: Error) => {
        // Skip if stop() already handled the cleanup
        if (
          this.state === SessionState.Stopping ||
          this.state === SessionState.Completed
        ) {
          console.log(`[session] onError ignored (state: ${this.state})`);
          return;
        }
        this.flushPendingThought();
        this.state = SessionState.Failed;

        // The SDK result message often has more detail than the generic process exit error
        const result = this.lastResultMessage;
        const sdkErrors = Array.isArray(result?.errors)
          ? (result.errors as string[])
          : [];
        const errorMsg =
          sdkErrors.length > 0 ? sdkErrors.join("; ") : error.message;

        console.error("[session] Error:", errorMsg);
        await this.config.reporter.reportError(agentSessionId, errorMsg);
        await this.notifyCompletion(agentSessionId, "failed", errorMsg);
      },
    };

    this.runner = new ClaudeRunner(runnerConfig);

    // Live activity reporting to Linear
    // Buffer assistant messages so the final one can be sent as Response instead of Thought.
    this.runner.on("tool-use", (toolName: string, input: unknown) => {
      if (toolName === "AskUserQuestion") return;
      this.flushPendingThought();
      this.config.reporter.reportAction(agentSessionId, toolName, input);
    });
    this.runner.on("assistant", (content: string) => {
      this.flushPendingThought();
      this.pendingThought = { agentSessionId, content };
    });

    // startStreaming() resolves when the session ENDS, not when it starts.
    // Fire it off without awaiting — onComplete/onError callbacks handle lifecycle.
    this.runner.startStreaming(prompt).catch((err) => {
      // Only transition to Failed if callbacks haven't already handled it
      if (
        this.state === SessionState.Starting ||
        this.state === SessionState.Running
      ) {
        this.state = SessionState.Failed;
        console.error("[session] startStreaming error:", err);
      }
    });

    this.state = SessionState.Running;
  }

  addMessage(content: string): void {
    if (!this.runner || this.state !== SessionState.Running) {
      throw new Error(`Cannot add message: current state is ${this.state}`);
    }

    // If there's a pending elicitation, treat this message as the user's answer.
    if (this.pendingElicitation) {
      const { questionText, resolve } = this.pendingElicitation;
      this.pendingElicitation = null;
      console.log(`[session] Elicitation answered: "${content.slice(0, 100)}"`);
      resolve({
        answered: true,
        answers: { [questionText]: content },
      });
      return;
    }

    this.runner.addStreamMessage(content);
  }

  /** Whether the session is currently waiting for a user answer to an elicitation. */
  hasPendingElicitation(): boolean {
    return this.pendingElicitation !== null;
  }

  async stop(reason?: string): Promise<void> {
    if (
      !this.runner ||
      (this.state !== SessionState.Running &&
        this.state !== SessionState.Starting)
    ) {
      throw new Error(`Cannot stop session: current state is ${this.state}`);
    }

    // Cancel any pending elicitation so the blocked callback resolves
    if (this.pendingElicitation) {
      this.pendingElicitation.resolve({
        answered: false,
        message: "Session stopped.",
      });
      this.pendingElicitation = null;
    }

    this.state = SessionState.Stopping;
    console.log(`[session] Stopping${reason ? `: ${reason}` : ""}`);
    this.runner.stop();
    this.state = SessionState.Completed;

    if (this.agentSessionId) {
      await this.config.reporter.reportCompletion(
        this.agentSessionId,
        reason ? `Session stopped: ${reason}` : "Session stopped by user.",
      );
      await this.notifyCompletion(this.agentSessionId, "stopped", reason);
    }

    this.runner = null;
  }

  getState(): SessionState {
    return this.state;
  }

  getSessionId(): string | null {
    return this.agentSessionId;
  }

  getClaudeSessionId(): string | null {
    return this._claudeSessionId;
  }

  private async notifyCompletion(
    agentSessionId: string,
    status: "completed" | "failed" | "stopped",
    summary?: string,
  ): Promise<void> {
    const baseUrl = this.config.orchestratorUrl;
    if (!baseUrl) return;

    // Upload Claude projects artifacts before notifying completion
    await this.uploadArtifacts(agentSessionId);

    try {
      await fetch(`${baseUrl}/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentSessionId,
          status,
          summary,
          prUrl: this.config.reporter.getPrUrl(agentSessionId),
          previewUrls: this.config.reporter.getPreviewUrls(agentSessionId),
        }),
      });
      console.log(`[session] Completion callback sent to ${baseUrl}/callback`);
    } catch (err) {
      console.warn(
        "[session] Completion callback failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  private async notifyWaitingForInput(
    agentSessionId: string,
    header: string,
  ): Promise<void> {
    const baseUrl = this.config.orchestratorUrl;
    if (!baseUrl) return;

    try {
      await fetch(`${baseUrl}/session-waiting`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentSessionId, header }),
      });
    } catch (err) {
      console.warn(
        "[session] Failed to notify waiting-for-input:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  private async reportClaudeSessionId(
    agentSessionId: string,
    claudeSessionId: string,
  ): Promise<void> {
    const baseUrl = this.config.orchestratorUrl;
    if (!baseUrl) return;

    try {
      await fetch(`${baseUrl}/session-update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentSessionId, claudeSessionId }),
      });
      console.log(`[session] Reported claudeSessionId to orchestrator`);
    } catch (err) {
      console.warn(
        "[session] Failed to report claudeSessionId:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  private async notifyPreviewUrl(
    agentSessionId: string,
    previewUrl: string,
    label: string,
  ): Promise<void> {
    const baseUrl = this.config.orchestratorUrl;
    if (!baseUrl) return;

    try {
      await fetch(`${baseUrl}/session-preview-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentSessionId, previewUrl, label }),
      });
      console.log(`[session] Reported preview URL to orchestrator`);
    } catch (err) {
      console.warn(
        "[session] Failed to report preview URL:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  private async uploadArtifacts(agentSessionId: string): Promise<void> {
    const baseUrl = this.config.orchestratorUrl;
    if (!baseUrl) return;

    const claudeProjectsDir = resolve(this.config.claudeProjectsDir);
    if (!existsSync(claudeProjectsDir)) {
      console.log(
        "[session] No .claude/projects dir found, skipping artifact upload",
      );
      return;
    }

    try {
      const tarPath = "/tmp/claude-projects.tar.gz";
      execSync(
        `tar -czf ${tarPath} -C ${resolve(claudeProjectsDir, "..")} projects`,
        { stdio: "pipe" },
      );

      const tarData = readFileSync(tarPath);
      await fetch(`${baseUrl}/session-artifacts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/gzip",
          "x-agent-session-id": agentSessionId,
        },
        body: tarData,
      });
      console.log(
        `[session] Uploaded artifacts for ${agentSessionId} (${tarData.length} bytes)`,
      );
    } catch (err) {
      console.warn(
        "[session] Failed to upload artifacts:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  /** Flush any buffered assistant text as a Thought (it wasn't the final message). */
  private flushPendingThought(): void {
    if (this.pendingThought) {
      const { agentSessionId, content } = this.pendingThought;
      this.pendingThought = null;
      this.config.reporter.reportThought(agentSessionId, content);
    }
  }

  reset(): void {
    if (this.pendingElicitation) {
      this.pendingElicitation.resolve({
        answered: false,
        message: "Session reset.",
      });
      this.pendingElicitation = null;
    }
    this.runner = null;
    this.agentSessionId = null;
    this._issueId = null;
    this._claudeSessionId = null;
    this.messageCount = 0;
    this.lastResultMessage = null;
    this.pendingThought = null;
    this.state = SessionState.Idle;
  }
}

/**
 * Format a Claude AskUserQuestion as markdown for display in Linear.
 */
function formatElicitation(question: {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}): string {
  const lines: string[] = [];
  lines.push(`## ${question.header}`);
  lines.push("");
  lines.push(question.question);
  lines.push("");
  for (const opt of question.options) {
    lines.push(`- **${opt.label}** — ${opt.description}`);
  }
  if (question.multiSelect) {
    lines.push("");
    lines.push("_(You may select multiple options)_");
  }
  return lines.join("\n");
}
