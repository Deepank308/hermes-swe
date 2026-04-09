export interface PreviewEntry {
  url: string;
  label: string;
}

export enum SessionState {
  Idle = "idle",
  Starting = "starting",
  Running = "running",
  Stopping = "stopping",
  Completed = "completed",
  Failed = "failed",
}

export interface RunRequest {
  prompt: string;
  agentSessionId: string;
  issueId: string;
  issueTitle: string;
  teamId: string;
  branch: string;
  /** Previous agentSessionId to resume (looks up Claude session ID internally) */
  resumeAgentSessionId?: string;
  /** Claude CLI session ID — passed by orchestrator for resume on fresh instances */
  claudeSessionId?: string;
  /** Plan steps from previous session — restored into LinearReporter on resume */
  plan?: Array<{ content: string; status: string }>;
  /** Previous preview URLs — seeded so they're preserved across resume */
  previousPreviewUrls?: PreviewEntry[];
}

export interface MessageRequest {
  agentSessionId: string;
  content: string;
  authorName?: string;
}

export interface StopRequest {
  reason?: string;
}

export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface HealthResponse {
  status: string;
  sessionState: SessionState;
  agentSessionId?: string | null;
  uptime: number;
}
