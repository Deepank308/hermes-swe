import { homedir } from "node:os";
import { resolve } from "node:path";
import { LinearClient } from "@linear/sdk";
import { loadSystemPrompt } from "./prompt-loader.js";
import { LinearReporter } from "./linear-reporter.js";
import { SessionManager } from "./session.js";
import { SessionStore } from "./session-store.js";
import { createHttpServer, parseBody, sendJson } from "./server.js";
import {
  scheduleGitHubTokenRefresh,
  clearGitHubTokenRefresh,
} from "./github-token.js";
import { SessionState } from "./types.js";
import type {
  RunRequest,
  MessageRequest,
  StopRequest,
  HealthResponse,
} from "./types.js";

// --- Environment ---
const LINEAR_OAUTH_ACCESS_TOKEN = process.env.LINEAR_OAUTH_ACCESS_TOKEN;
const LINEAR_API_KEY = process.env.LINEAR_API_KEY;
if (!LINEAR_OAUTH_ACCESS_TOKEN && !LINEAR_API_KEY) {
  console.error(
    "[agent-service] Set LINEAR_OAUTH_ACCESS_TOKEN or LINEAR_API_KEY",
  );
  process.exit(1);
}
const PORT = Number(process.env.PORT ?? 3000);
const WORKSPACE_DIR = resolvePath(
  process.env.WORKSPACE_DIR ?? "/workspace/repo",
);
const LOGS_DIR = resolvePath(process.env.LOGS_DIR ?? "/home/ubuntu/.cyrus");
const CLAUDE_PROJECTS_DIR = resolvePath(
  process.env.CLAUDE_PROJECTS_DIR ?? "/home/ubuntu/.claude/projects",
);
const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? "opus";
const MAX_TURNS = Number(process.env.MAX_TURNS ?? 200);
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL;
const GITHUB_TOKEN_EXPIRES_AT = process.env.GITHUB_TOKEN_EXPIRES_AT;

const startTime = Date.now();

// --- Bootstrap ---
const systemPrompt = await loadSystemPrompt();
console.log(
  `[agent-service] System prompt loaded (${systemPrompt.length} chars)`,
);

const linearClient = LINEAR_OAUTH_ACCESS_TOKEN
  ? new LinearClient({ accessToken: LINEAR_OAUTH_ACCESS_TOKEN })
  : new LinearClient({ apiKey: LINEAR_API_KEY! });
const reporter = new LinearReporter(linearClient, WORKSPACE_DIR);
const sessionStore = new SessionStore(resolve(LOGS_DIR, "sessions.json"));

const session = new SessionManager({
  workspaceDir: WORKSPACE_DIR,
  logsDir: LOGS_DIR,
  claudeProjectsDir: CLAUDE_PROJECTS_DIR,
  model: CLAUDE_MODEL,
  maxTurns: MAX_TURNS,
  systemPrompt,
  reporter,
  sessionStore,
  orchestratorUrl: ORCHESTRATOR_URL,
});

// --- Schedule GitHub token refresh ---
if (GITHUB_TOKEN_EXPIRES_AT && ORCHESTRATOR_URL) {
  scheduleGitHubTokenRefresh(GITHUB_TOKEN_EXPIRES_AT, ORCHESTRATOR_URL);
}

// --- HTTP Server ---
const server = createHttpServer({
  "GET /health": (_req, res) => {
    const data: HealthResponse = {
      status: "ok",
      sessionState: session.getState(),
      agentSessionId: session.getSessionId(),
      uptime: Math.floor((Date.now() - startTime) / 1000),
    };
    sendJson(res, 200, { ok: true, data });
  },

  "POST /run": async (req, res) => {
    const body = await parseBody<RunRequest>(req);

    if (!body.prompt || !body.agentSessionId || !body.issueId) {
      sendJson(res, 400, {
        ok: false,
        error: "Missing required fields: prompt, agentSessionId, issueId",
      });
      return;
    }

    const state = session.getState();
    if (state === SessionState.Running || state === SessionState.Starting) {
      sendJson(res, 409, {
        ok: false,
        error: `Session already active (state: ${state})`,
      });
      return;
    }
    // Auto-reset completed/failed sessions so a new run can start
    if (state !== SessionState.Idle) {
      session.reset();
    }

    try {
      await session.start(body);
      sendJson(res, 200, {
        ok: true,
        data: { sessionState: session.getState() },
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to start session";
      sendJson(res, 500, { ok: false, error: message });
    }
  },

  "POST /message": async (req, res) => {
    const body = await parseBody<MessageRequest>(req);

    if (!body.agentSessionId || !body.content) {
      sendJson(res, 400, {
        ok: false,
        error: "Missing required fields: agentSessionId, content",
      });
      return;
    }

    const prefix = body.authorName ? `[${body.authorName}]: ` : "";
    const content = `${prefix}${body.content}`;
    const state = session.getState();

    try {
      if (state === SessionState.Running) {
        // Inject message into the active streaming session
        session.addMessage(content);
        sendJson(res, 200, { ok: true });
      } else if (
        state === SessionState.Idle ||
        state === SessionState.Completed ||
        state === SessionState.Failed
      ) {
        // Auto-resume: start a new runner continuing the previous conversation
        await session.resume(body.agentSessionId, content);
        sendJson(res, 200, {
          ok: true,
          data: { sessionState: session.getState() },
        });
      } else {
        sendJson(res, 409, {
          ok: false,
          error: `Session is transitioning (state: ${state})`,
        });
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to send message";
      sendJson(res, 409, { ok: false, error: message });
    }
  },

  "POST /stop": async (req, res) => {
    const body = await parseBody<StopRequest>(req);

    try {
      await session.stop(body.reason);
      sendJson(res, 200, {
        ok: true,
        data: { sessionState: session.getState() },
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to stop session";
      sendJson(res, 409, { ok: false, error: message });
    }
  },
});

server.listen(PORT, async () => {
  console.log(`[agent-service] Listening on port ${PORT}`);

  // Notify orchestrator that we're ready
  const agentSessionId = process.env.AGENT_SESSION_ID;
  if (ORCHESTRATOR_URL && agentSessionId) {
    try {
      const resp = await fetch(`${ORCHESTRATOR_URL}/agent-ready`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentSessionId }),
      });
      if (!resp.ok) {
        console.error(`[agent-service] /agent-ready failed: ${resp.status}`);
      } else {
        console.log("[agent-service] Notified orchestrator: ready");
      }
    } catch (err) {
      console.error("[agent-service] Failed to notify orchestrator:", err);
    }
  }
});

// --- Graceful shutdown ---
async function shutdown(signal: string) {
  console.log(`[agent-service] ${signal} received, shutting down...`);

  clearGitHubTokenRefresh();

  if (
    session.getState() === SessionState.Running ||
    session.getState() === SessionState.Starting
  ) {
    try {
      await session.stop("Server shutting down");
    } catch {
      // already stopped
    }
  }

  server.close(() => {
    console.log("[agent-service] Server closed");
    process.exit(0);
  });

  // Force exit after 5s
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// --- Helpers ---
function resolvePath(p: string): string {
  if (p.startsWith("~/")) {
    return resolve(homedir(), p.slice(2));
  }
  return resolve(p);
}
