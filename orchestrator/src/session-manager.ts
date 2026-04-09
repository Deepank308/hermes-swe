import { config, getRepoConfig } from "./config.js";
import * as sessionStore from "./session-store.js";
import { generateUserData } from "./user-data.js";
import {
  launchInstance,
  terminateInstance,
  listAgentInstances,
  getRootVolumeId,
  createSnapshot,
} from "./ec2.js";
import { notifySlack } from "./slack.js";
import { getLinearToken } from "./linear-token.js";
import { getLinearClient, postActivity } from "./linear-activity.js";
import { generateGitHubToken } from "./github-token.js";
import type { SessionRecord, CompletionCallback } from "./types.js";
import { AgentActivityType } from "@linear/sdk";
import { resolveRepo } from "./repo-resolver.js";

export interface StartSessionOptions {
  agentSessionId: string;
  issueId: string;
  /** Linear organization ID — used to route to the correct OAuth token */
  organizationId: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  teamId: string;
  agentSessionUrl?: string;
  promptContext?: string | null;
  /** Email of the person who triggered the session (from Linear webhook creator field) */
  creatorEmail?: string;
}

interface ProvisionOptions {
  session: SessionRecord;
  /** The prompt to send to the agent (promptContext for new, user message for resume) */
  prompt: string;
  /** If set, agent-service will resume this previous session instead of starting fresh */
  resumeAgentSessionId?: string;
  /** Plan steps from the previous session — restored on agent for resume continuity */
  plan?: Array<{ content: string; status: string }>;
}

/** Timeout for agent-service requests that should respond quickly (/stop, /message) */
const AGENT_REQUEST_TIMEOUT_MS = 10_000;
/** Timeout for /run which may take longer to initialize */
const AGENT_RUN_TIMEOUT_MS = 30_000;
/** How often to sweep for orphaned EC2 instances */
const SWEEP_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours

class SessionManager {
  /** Timeout handles for agent-ready callbacks, keyed by agentSessionId */
  private provisionTimeouts = new Map<string, NodeJS.Timeout>();

  /** Timeout handles for grace-period instance termination, keyed by agentSessionId */
  private terminationTimeouts = new Map<string, NodeJS.Timeout>();

  // --- Public ---
  // --- Actions from Linear webhook ---

  async startSession(opts: StartSessionOptions): Promise<void> {
    const {
      agentSessionId,
      issueId,
      organizationId,
      identifier,
      title,
      description,
      url,
      teamId,
      agentSessionUrl,
      promptContext,
      creatorEmail,
    } = opts;

    const repo = await resolveRepo(organizationId, issueId, agentSessionId);

    // Determine branch — branchName isn't in the webhook payload
    let branch = `hermes/${identifier}`;
    try {
      const client = await getLinearClient(organizationId);
      const issue = await client.issue(issueId);
      branch = issue.branchName ?? branch;
    } catch (err) {
      console.error(
        `[session:start] Failed to get issue ${issueId}:`,
        err instanceof Error ? err.message : err,
      );
    }

    await postActivity(
      agentSessionId,
      `Working in ${repo} · ${branch}`,
      organizationId,
    );

    // Build prompt: prefer Linear's structured promptContext, fall back to manual
    const prompt = promptContext
      ? `<issue-url>${url}</issue-url>\n${promptContext}`
      : `Work on Linear ticket ${identifier}: ${title}\n\n${description}\n\nLinear issue: ${url}`;

    const record: SessionRecord = {
      agentSessionId,
      repo,
      url,
      agentSessionUrl,
      issueId,
      issueIdentifier: identifier,
      issueTitle: title,
      teamId,
      organizationId,
      branch,
      prompt,
      creatorEmail,
      status: "provisioning",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Concurrency check
    const activeCount = await sessionStore.getActiveCount();
    if (activeCount >= config.maxConcurrent) {
      record.status = "queued";
    }
    await sessionStore.create(record);

    const repoShort = repo.split("/").pop() ?? repo;
    notifySlack(agentSessionId, `${repoShort} · ${branch}`);

    if (record.status === "queued") {
      await postActivity(
        agentSessionId,
        `Queued — ${activeCount} agents already running`,
        organizationId,
        { ephemeral: true, type: AgentActivityType.Response },
      );
      notifySlack(agentSessionId, `Queued (${activeCount} active)`);
    } else {
      // Fire-and-forget — webhook must return quickly
      this.provision({ session: record, prompt }).catch((err) => {
        console.error(
          `[session:start] provision failed for ${agentSessionId}:`,
          err,
        );
      });
    }
  }

  async cancelSession(session: SessionRecord): Promise<void> {
    const { agentSessionId } = session;
    console.log(
      `[session:cancel] Cancelling ${agentSessionId} (status: ${session.status})`,
    );

    // Clear any pending timers
    this.clearProvisionTimeout(agentSessionId);
    this.clearGraceTermination(agentSessionId);

    // Mark stopped first — provision() checks this after launchInstance()
    await sessionStore.update(agentSessionId, {
      status: "stopped",
      summary: "Stopped by user",
    });

    // Re-read to pick up instanceId that provision() may have written
    const current = await sessionStore.get(agentSessionId);
    if (current?.instanceId) {
      await cleanupCloudflareTunnel(agentSessionId);
      await terminateInstance(current.instanceId);
    }

    await sessionStore.update(agentSessionId, {
      instanceId: undefined,
      privateIp: undefined,
    });

    notifySlack(agentSessionId, "Agent stopped: Stopped by user");

    // A slot may have opened up — drain the queue
    await this.drainQueue();
  }

  async stopAgent(session: SessionRecord): Promise<void> {
    console.log(`[session:stop] Stop signal for ${session.agentSessionId}`);
    try {
      await fetch(
        `http://${session.privateIp}:${config.agentServicePort}/stop`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "Stopped by user" }),
          signal: AbortSignal.timeout(AGENT_REQUEST_TIMEOUT_MS),
        },
      );
    } catch (err) {
      console.error(
        `[session:stop] Failed to stop agent:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  async forwardMessage(
    session: SessionRecord,
    agentSessionId: string,
    content: string,
    authorName: string,
  ): Promise<void> {
    console.log(
      `[session:message] Message for ${agentSessionId} from ${authorName}: ${content.slice(0, 100)}`,
    );
    try {
      await fetch(
        `http://${session.privateIp}:${config.agentServicePort}/message`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentSessionId,
            content,
            authorName,
          }),
          signal: AbortSignal.timeout(AGENT_REQUEST_TIMEOUT_MS),
        },
      );
    } catch (err) {
      console.error(
        `[session:message] Failed to forward to agent:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  async resumeSession(
    session: SessionRecord,
    agentSessionId: string,
    content: string,
    authorName: string,
    plan?: Array<{ content: string; status: string }>,
  ): Promise<void> {
    console.log(
      `[session:resume] Resuming session ${agentSessionId} (was ${session.status})`,
    );

    // Try to reuse the still-alive instance (grace period after completion)
    if (session.privateIp && session.instanceId) {
      // Clear grace-period termination timer
      this.clearGraceTermination(agentSessionId);

      console.log(
        `[session:resume] Resuming ${agentSessionId} on existing instance ${session.instanceId}`,
      );
      await postActivity(
        agentSessionId,
        "Resuming on existing instance...",
        session.organizationId,
        { ephemeral: true },
      );

      try {
        const resp = await fetch(
          `http://${session.privateIp}:${config.agentServicePort}/message`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agentSessionId,
              content,
              authorName,
            }),
            signal: AbortSignal.timeout(AGENT_REQUEST_TIMEOUT_MS),
          },
        );
        if (!resp.ok) {
          throw new Error(
            `/message failed (${resp.status}): ${await resp.text()}`,
          );
        }
        await sessionStore.update(agentSessionId, { status: "running" });
        return;
      } catch (err) {
        console.warn(
          `[session:resume] Reuse failed for ${agentSessionId}, provisioning new:`,
          err instanceof Error ? err.message : err,
        );

        // terminate the instance to avoid orphaned sessions
        await terminateInstance(session.instanceId);

        // Clear stale instance info, fall through to provision
        await sessionStore.update(agentSessionId, {
          instanceId: undefined,
          privateIp: undefined,
        });
      }
    }

    await sessionStore.update(agentSessionId, { status: "provisioning" });

    // User's follow-up message is the prompt — resumed session already has issue context
    this.provision({
      session: { ...session, status: "provisioning" },
      prompt: content,
      resumeAgentSessionId: agentSessionId,
      plan,
    }).catch((err) => {
      console.error(
        `[session:resume] Resume provision failed for ${agentSessionId}:`,
        err,
      );
    });
  }

  // --- Actions from agent-service ---

  async handleAgentReady(agentSessionId: string): Promise<void> {
    // Clear provision timeout
    this.clearProvisionTimeout(agentSessionId);

    const session = await sessionStore.get(agentSessionId);
    if (!session) {
      console.warn(`[session:agent-ready] No session found for ${agentSessionId}`);
      return;
    }

    if (session.status !== "provisioning") {
      console.warn(
        `[session:agent-ready] Session ${agentSessionId} is not provisioning (status: ${session.status}), cancelling`,
      );
      await this.cancelSession(session);
      return;
    }

    console.log(`[session:agent-ready] Agent ${agentSessionId} is ready, sending /run`);

    try {
      await this.startAgent(agentSessionId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[session:agent-ready] Failed to start agent ${agentSessionId}:`,
        message,
      );

      await sessionStore.update(agentSessionId, {
        status: "failed",
        summary: message,
      });

      if (session.instanceId) {
        await terminateInstance(session.instanceId);
      }

      await postActivity(
        agentSessionId,
        `Failed to start: ${message}`,
        session.organizationId,
        { type: AgentActivityType.Response },
      );
      notifySlack(agentSessionId, `Failed: ${message}`);
    }
  }

  async handleCompletion(callback: CompletionCallback): Promise<void> {
    const { agentSessionId, status, summary, prUrl, previewUrls } = callback;
    console.log(`[session:callback] ${agentSessionId} → ${status}`);

    const session = await sessionStore.get(agentSessionId);
    if (!session) {
      console.warn(`[session:callback] No session found for ${agentSessionId}`);
      return;
    }

    const updates: Partial<typeof session> = { status, summary };
    if (prUrl) updates.prUrl = prUrl;
    // Merge incoming preview URLs with existing (deduplicated by URL)
    if (previewUrls?.length) {
      const existing = session.previewUrls ?? [];
      const existingUrlSet = new Set(existing.map((e) => e.url));
      const newEntries = previewUrls.filter((e) => !existingUrlSet.has(e.url));
      if (newEntries.length) {
        updates.previewUrls = [...existing, ...newEntries];
      }
    }
    await sessionStore.update(agentSessionId, updates);

    if (session.instanceId) {
      console.log(
        `[session:callback] Keeping instance ${session.instanceId} alive for ${config.agentReadyTimeoutMs / 1000}s grace period`,
      );
      this.scheduleGraceTermination(
        agentSessionId,
        session.instanceId,
        config.agentReadyTimeoutMs,
      );
    }

    notifySlack(
      agentSessionId,
      `Agent ${status}${summary ? `: ${summary}` : ""}`,
      { mention: true },
    );

    // Notify Slack about PR / new preview URLs
    if (prUrl && prUrl !== session.prUrl) {
      notifySlack(agentSessionId, `PR: ${prUrl}`);
    }
    const existingUrlSet = new Set(
      (session.previewUrls ?? []).map((e) => e.url),
    );
    for (const entry of previewUrls ?? []) {
      if (!existingUrlSet.has(entry.url)) {
        notifySlack(agentSessionId, `Preview (${entry.label}): ${entry.url}`);
      }
    }

    // Process queue
    await this.drainQueue();
  }

  // --- Actions from orchestrator ---

  async recoverOrphanedSessions(): Promise<void> {
    const sessions = await sessionStore.getAll();
    const withInstance = sessions.filter((s) => s.instanceId);

    console.log(
      `[session:recovery] Found ${withInstance.length} session(s) with active instances`,
    );

    // Poll running sessions in parallel (each poll has a 5s timeout)
    const runningSessions = withInstance.filter((s) => s.status === "running");
    const healthResults = await Promise.all(
      runningSessions.map(async (session) => ({
        session,
        agentState: await this.pollAgentHealth(session.privateIp!),
      })),
    );

    // Process running session health results
    for (const { session, agentState } of healthResults) {
      const { agentSessionId, instanceId } = session;

      if (agentState === "completed" || agentState === "failed") {
        console.log(
          `[session:recovery] Session ${agentSessionId} agent reports "${agentState}" — processing missed callback`,
        );
        await this.handleCompletion({ agentSessionId, status: agentState });
      } else if (agentState === "running" || agentState === "starting") {
        console.log(
          `[session:recovery] Session ${agentSessionId} is still running — leaving alone`,
        );
      } else {
        console.log(
          `[session:recovery] Session ${agentSessionId} agent unreachable (state: ${agentState}), terminating ${instanceId}`,
        );
        await terminateInstance(instanceId!);
        await sessionStore.update(agentSessionId, {
          status: "failed",
          summary: "Agent unreachable after orchestrator restart",
          instanceId: undefined,
          privateIp: undefined,
        });
        notifySlack(
          agentSessionId,
          "Failed: Agent unreachable after orchestrator restart",
        );
      }
    }

    // Process non-running sessions (provisioning, completed, failed, stopped)
    for (const session of withInstance) {
      const { agentSessionId, status, instanceId, updatedAt } = session;
      if (status === "running") continue; // already handled above
      const elapsed = Date.now() - new Date(updatedAt).getTime();
      const remaining = config.agentReadyTimeoutMs - elapsed;

      if (status === "provisioning") {
        if (remaining <= 0) {
          // Already past timeout — terminate and mark failed
          console.log(
            `[session:recovery] Session ${agentSessionId} provisioning timed out (${Math.round(elapsed / 1000)}s elapsed), terminating ${instanceId}`,
          );
          await terminateInstance(instanceId!);
          await sessionStore.update(agentSessionId, {
            status: "failed",
            summary: "Provisioning timed out (recovered after restart)",
            instanceId: undefined,
            privateIp: undefined,
          });
          notifySlack(
            agentSessionId,
            "Failed: Provisioning timed out (recovered after restart)",
          );
        } else {
          console.log(
            `[session:recovery] Session ${agentSessionId} provisioning — re-creating timeout (${Math.round(remaining / 1000)}s remaining)`,
          );
          this.scheduleProvisionTimeout(agentSessionId, remaining);
        }
        continue;
      }

      // completed / failed / stopped — these have grace-period termination timers
      if (
        status === "completed" ||
        status === "failed" ||
        status === "stopped"
      ) {
        if (remaining <= 0) {
          console.log(
            `[session:recovery] Session ${agentSessionId} (${status}) grace period expired (${Math.round(elapsed / 1000)}s elapsed), terminating ${instanceId}`,
          );
          await terminateInstance(instanceId!);
          await sessionStore.update(agentSessionId, {
            instanceId: undefined,
            privateIp: undefined,
          });
        } else {
          console.log(
            `[session:recovery] Session ${agentSessionId} (${status}) — re-creating termination timeout (${Math.round(remaining / 1000)}s remaining)`,
          );
          this.scheduleGraceTermination(agentSessionId, instanceId!, remaining);
        }
      }
    }

    // Drain queue — if there's capacity and queued sessions exist, dequeue them
    await this.drainQueue();

    console.log("[session:recovery] Orphaned session recovery complete");
  }

  /**
   * Query AWS for running hermes agent instances and terminate any that aren't
   * tracked in the session store (or whose session is already terminal with no
   * grace timer). Catches instances leaked by crashes between launch and store write.
   */
  async sweepOrphanedInstances(): Promise<void> {
    const instances = await listAgentInstances();
    if (instances.length === 0) return;

    const sessions = await sessionStore.getAll();
    const trackedInstanceIds = new Set(
      sessions.filter((s) => s.instanceId).map((s) => s.instanceId),
    );

    let terminated = 0;
    for (const inst of instances) {
      if (trackedInstanceIds.has(inst.instanceId)) continue;

      // Skip recently launched instances — they may be mid-provisioning
      // (between launchInstance() and sessionStore.update())
      const ageMs = inst.launchTime
        ? Date.now() - inst.launchTime.getTime()
        : Infinity;
      if (ageMs < config.agentReadyTimeoutMs) {
        console.log(
          `[session:sweep] Skipping young instance ${inst.instanceId} (age: ${Math.round(ageMs / 1000)}s)`,
        );
        continue;
      }

      console.log(
        `[session:sweep] Terminating orphaned instance ${inst.instanceId} (session: ${inst.agentSessionId ?? "none"}, age: ${Math.round(ageMs / 1000)}s)`,
      );
      await terminateInstance(inst.instanceId);
      terminated++;
    }

    if (terminated > 0) {
      console.log(
        `[session:sweep] Terminated ${terminated} orphaned instance(s) out of ${instances.length} running`,
      );
    }
  }

  /**
   * Start periodic sweep for orphaned instances.
   * Runs recoverOrphanedSessions + sweepOrphanedInstances every SWEEP_INTERVAL_MS.
   */
  startPeriodicSweep(): void {
    const timer = setInterval(async () => {
      try {
        console.log("[session:sweep] Starting periodic sweep...");
        await this.recoverOrphanedSessions();
        await this.sweepOrphanedInstances();
        console.log("[session:sweep] Periodic sweep complete");
      } catch (err) {
        console.error(
          "[session:sweep] Periodic sweep failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }, SWEEP_INTERVAL_MS);
    timer.unref();
    console.log(
      `[session:sweep] Periodic sweep scheduled every ${SWEEP_INTERVAL_MS / 1000 / 60} minutes`,
    );
  }

  // --- Private ---

  private async startAgent(agentSessionId: string): Promise<void> {
    const session = await sessionStore.get(agentSessionId);
    if (!session) {
      throw new Error(`No session found for ${agentSessionId}`);
    }

    const { privateIp, prompt, resumeAgentSessionId } = session;
    if (!privateIp) {
      throw new Error(`Session ${agentSessionId} has no privateIp`);
    }
    if (!prompt) {
      throw new Error(`Session ${agentSessionId} has no stored prompt`);
    }

    const runBody: Record<string, unknown> = {
      prompt,
      agentSessionId,
      issueId: session.issueId,
      issueTitle: session.issueTitle,
      teamId: session.teamId,
      branch: session.branch,
    };
    if (resumeAgentSessionId) {
      runBody.resumeAgentSessionId = resumeAgentSessionId;
      runBody.claudeSessionId = session.claudeSessionId;
    }
    if (session.plan?.length) {
      runBody.plan = session.plan;
    }
    if (session.previewUrls?.length) {
      runBody.previousPreviewUrls = session.previewUrls;
    }

    const runResp = await fetch(
      `http://${privateIp}:${config.agentServicePort}/run`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(runBody),
        signal: AbortSignal.timeout(AGENT_RUN_TIMEOUT_MS),
      },
    );

    if (!runResp.ok) {
      const respBody = await runResp.text();
      throw new Error(`Agent /run failed (${runResp.status}): ${respBody}`);
    }

    await sessionStore.update(agentSessionId, { status: "running" });
    notifySlack(
      agentSessionId,
      `Agent ${resumeAgentSessionId ? "resumed" : "started"}`,
    );
  }

  private async provision(opts: ProvisionOptions): Promise<void> {
    const { session, resumeAgentSessionId } = opts;
    const { agentSessionId, issueIdentifier: identifier } = session;
    let launchedInstanceId: string | undefined;

    await postActivity(
      agentSessionId,
      "Provisioning dev environment...",
      session.organizationId,
      { ephemeral: true },
    );
    try {
      // Store prompt, resumeAgentSessionId, and plan in session so startAgent() can use them
      await sessionStore.update(agentSessionId, {
        prompt: opts.prompt,
        resumeAgentSessionId,
        plan: opts.plan,
      });

      const linearOAuthToken = await getLinearToken(session.organizationId);

      // Generate a fresh GitHub App installation token for this session
      const { token: githubToken, expiresAt: githubTokenExpiresAt } =
        await generateGitHubToken();

      // If resuming, generate a pre-signed URL for the previous session's artifacts
      let artifactsUrl: string | undefined;
      if (resumeAgentSessionId) {
        artifactsUrl = await sessionStore.getArtifactsUrl(resumeAgentSessionId);
        if (artifactsUrl) {
          console.log(
            `[session:provision] Found artifacts for previous session ${resumeAgentSessionId}`,
          );
        }
      }

      // Look up repo-specific config for AMI, instance type, and secrets
      const repoConfig = getRepoConfig(session.repo);

      // Resolve repo-specific secrets from orchestrator's loaded secrets
      const repoSecrets: Record<string, string> = {};
      for (const secretKey of repoConfig.secrets) {
        const value =
          config.secrets[secretKey as keyof typeof config.secrets] ?? "";
        repoSecrets[secretKey] = value as string;
      }

      const userData = generateUserData({
        githubToken,
        githubTokenExpiresAt,
        linearOAuthToken,
        orchestratorUrl: config.callbackBaseUrl,
        branch: session.branch,
        agentSessionId,
        artifactsUrl,
        agentServicePort: config.agentServicePort,
        repo: session.repo,
        amiName: repoConfig.amiName,
        workspaceDir: repoConfig.workspaceDir,
        repoSecrets,
      });

      console.log(
        `[session:provision] Launching EC2 for ${identifier} (repo: ${session.repo})${resumeAgentSessionId ? " (resume)" : ""}...`,
      );
      const { instanceId, privateIp } = await launchInstance({
        userData,
        tags: {
          Name: `hermes-${identifier}`,
          Project: "hermes",
          agentSessionId,
          issueId: session.issueId,
        },
        amiId: repoConfig.amiId || undefined,
        instanceType: repoConfig.instanceType || undefined,
      });
      launchedInstanceId = instanceId;

      // Write instanceId first so cancelSession() can find and terminate it
      await sessionStore.update(agentSessionId, { instanceId, privateIp });

      // Check if session was cancelled while we were launching
      const current = await sessionStore.get(agentSessionId);
      if (current?.status !== "provisioning") {
        console.log(
          `[session:provision] Session ${agentSessionId} was ${current?.status ?? "unknown"} during provisioning, terminating instance ${instanceId}`,
        );
        await terminateInstance(instanceId);
        return;
      }

      console.log(
        `[session:provision] Instance ${instanceId} running at ${privateIp}, waiting for agent-ready callback...`,
      );

      // Start provision timeout — if agent doesn't call back, mark as failed
      this.scheduleProvisionTimeout(agentSessionId, config.agentReadyTimeoutMs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[session:provision] Failed for ${agentSessionId}:`, message);

      await sessionStore.update(agentSessionId, {
        status: "failed",
        summary: message,
      });

      if (launchedInstanceId) {
        await terminateInstance(launchedInstanceId);
      }

      await postActivity(
        agentSessionId,
        `Failed to provision: ${message}`,
        session.organizationId,
        { type: AgentActivityType.Response },
      );
      notifySlack(agentSessionId, `Failed: ${message}`);
    }
  }

  private scheduleProvisionTimeout(
    agentSessionId: string,
    delayMs: number,
  ): void {
    // Clear any existing provision timeout to avoid orphaned timers
    this.clearProvisionTimeout(agentSessionId);

    const timeout = setTimeout(async () => {
      this.provisionTimeouts.delete(agentSessionId);
      const current = await sessionStore.get(agentSessionId);
      if (current?.status !== "provisioning") return;

      const message = `Agent did not call back within ${config.agentReadyTimeoutMs / 1000}s`;
      console.error(`[session:provision] Timeout for ${agentSessionId}: ${message}`);

      await sessionStore.update(agentSessionId, {
        status: "failed",
        summary: message,
      });
      if (current.instanceId) {
        await terminateInstance(current.instanceId);
      }
      await postActivity(
        agentSessionId,
        `Failed to provision: ${message}`,
        current.organizationId,
        { type: AgentActivityType.Response },
      );
      notifySlack(agentSessionId, `Failed: ${message}`);
    }, delayMs);
    timeout.unref();
    this.provisionTimeouts.set(agentSessionId, timeout);
  }

  private scheduleGraceTermination(
    agentSessionId: string,
    instanceId: string,
    delayMs: number,
  ): void {
    // Clear any existing grace termination to avoid orphaned timers
    this.clearGraceTermination(agentSessionId);

    const timeout = setTimeout(async () => {
      this.terminationTimeouts.delete(agentSessionId);

      try {
        // Snapshot the root EBS volume before terminating (best-effort, never blocks termination)
        if (config.snapshotRetentionDays > 0) {
          try {
            const volumeId = await getRootVolumeId(instanceId);
            if (volumeId) {
              const expiresAt = new Date(
                Date.now() + config.snapshotRetentionDays * 24 * 60 * 60 * 1000,
              );
              const snapshotId = await createSnapshot(volumeId, {
                Name: `hermes-${agentSessionId}`,
                Project: "hermes",
                agentSessionId,
                ExpiresAt: expiresAt.toISOString(),
              });
              if (snapshotId) {
                await sessionStore.update(agentSessionId, { snapshotId });
                console.log(
                  `[session:callback] Snapshot ${snapshotId} created for ${instanceId}, expires ${expiresAt.toISOString()}`,
                );
              }
            }
          } catch (err) {
            console.warn(
              `[session:callback] Snapshot failed for ${instanceId}:`,
              err instanceof Error ? err.message : err,
            );
          }
        }

        await cleanupCloudflareTunnel(agentSessionId);
      } finally {
        // Always terminate — even if snapshot or tunnel cleanup fails/hangs
        await terminateInstance(instanceId);
        await sessionStore.update(agentSessionId, {
          instanceId: undefined,
          privateIp: undefined,
        });
        console.log(
          `[session:callback] Grace period expired, terminated ${instanceId}`,
        );
      }
    }, delayMs);
    timeout.unref();
    this.terminationTimeouts.set(agentSessionId, timeout);
  }

  private clearProvisionTimeout(agentSessionId: string): void {
    const timeout = this.provisionTimeouts.get(agentSessionId);
    if (timeout) {
      clearTimeout(timeout);
      this.provisionTimeouts.delete(agentSessionId);
    }
  }

  private clearGraceTermination(agentSessionId: string): void {
    const timer = this.terminationTimeouts.get(agentSessionId);
    if (timer) {
      clearTimeout(timer);
      this.terminationTimeouts.delete(agentSessionId);
    }
  }

  private async drainQueue(): Promise<void> {
    const activeCount = await sessionStore.getActiveCount();
    const availableSlots = config.maxConcurrent - activeCount;

    for (let i = 0; i < availableSlots; i++) {
      const next = await sessionStore.getNextQueued();
      if (!next) break;

      console.log(
        `[session:queue] Dequeuing ${next.agentSessionId} for ${next.issueIdentifier}`,
      );
      await sessionStore.update(next.agentSessionId, {
        status: "provisioning",
      });

      const prompt =
        next.prompt ??
        `Work on Linear ticket ${next.issueIdentifier}: ${next.issueTitle}`;

      this.provision({
        session: { ...next, status: "provisioning" },
        prompt,
      }).catch((err) => {
        console.error(
          `[session:queue] provision failed for ${next.agentSessionId}:`,
          err,
        );
      });
    }
  }

  private async pollAgentHealth(privateIp: string): Promise<string> {
    try {
      const resp = await fetch(
        `http://${privateIp}:${config.agentServicePort}/health`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (!resp.ok) return "unreachable";
      const json = (await resp.json()) as {
        ok?: boolean;
        data?: { sessionState?: string };
      };
      if (!json.ok) return "unreachable";
      return json.data?.sessionState ?? "unreachable";
    } catch {
      return "unreachable";
    }
  }
}

/**
 * Delete a named Cloudflare tunnel and its DNS record for a session.
 * Derives tunnel name from the agent session ID: preview-{first 8 chars}.
 * Best-effort — logs warnings but never throws.
 */
async function cleanupCloudflareTunnel(agentSessionId: string): Promise<void> {
  const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ZONE_ID } =
    config.secrets;
  if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_ZONE_ID) {
    return; // Named tunnels not configured
  }

  const shortId = agentSessionId.slice(0, 8);
  const tunnelPrefix = `preview-${shortId}`;
  const headers = {
    Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
    "Content-Type": "application/json",
  };

  try {
    // Find all tunnels matching the prefix (covers both old single-tunnel
    // format "preview-{shortId}" and new multi-config "preview-{shortId}-{name}")
    // Note: Don't rely on the API's name filter — it does exact match, not prefix/substring.
    // Fetch all non-deleted tunnels and filter client-side by prefix.
    const listResp = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel?is_deleted=false&per_page=100`,
      { headers, signal: AbortSignal.timeout(10_000) },
    );
    const listData = (await listResp.json()) as {
      result?: Array<{ id: string; name: string }>;
    };
    const tunnels = (listData.result ?? []).filter(
      (t) => t.name === tunnelPrefix || t.name.startsWith(`${tunnelPrefix}-`),
    );

    if (tunnels.length === 0) {
      console.log(
        `[session:cleanup] No Cloudflare tunnels found for prefix ${tunnelPrefix}, skipping`,
      );
      return;
    }

    const previewDomain = config.previewDomain;

    for (const tunnel of tunnels) {
      // Delete DNS CNAME record for this tunnel
      if (previewDomain) {
        const hostname = `${tunnel.name}.${previewDomain}`;
        try {
          const dnsListResp = await fetch(
            `https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records?name=${hostname}&type=CNAME`,
            { headers, signal: AbortSignal.timeout(10_000) },
          );
          const dnsData = (await dnsListResp.json()) as {
            result?: Array<{ id: string }>;
          };
          const dnsRecordId = dnsData.result?.[0]?.id;
          if (dnsRecordId) {
            await fetch(
              `https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records/${dnsRecordId}`,
              {
                method: "DELETE",
                headers,
                signal: AbortSignal.timeout(10_000),
              },
            );
            console.log(
              `[session:cleanup] Deleted DNS record ${hostname} (${dnsRecordId})`,
            );
          }
        } catch (err) {
          console.warn(
            `[session:cleanup] Failed to delete DNS record for ${hostname}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }

      // Delete the tunnel
      try {
        await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel/${tunnel.id}`,
          {
            method: "DELETE",
            headers,
            signal: AbortSignal.timeout(10_000),
          },
        );
        console.log(
          `[session:cleanup] Deleted Cloudflare tunnel ${tunnel.name} (${tunnel.id})`,
        );
      } catch (err) {
        console.warn(
          `[session:cleanup] Failed to delete tunnel ${tunnel.name}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  } catch (err) {
    console.warn(
      `[session:cleanup] Failed to cleanup Cloudflare tunnels for ${tunnelPrefix}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

export const sessionManager = new SessionManager();
