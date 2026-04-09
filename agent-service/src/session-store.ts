import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

interface SessionRecord {
  agentSessionId: string;
  claudeSessionId: string;
  issueId: string;
  startedAt: string;
}

/**
 * Simple JSON file store mapping Linear agent session IDs to Claude session IDs.
 * Persists across server restarts.
 */
export class SessionStore {
  private records: Record<string, SessionRecord> = {};
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  save(agentSessionId: string, claudeSessionId: string, issueId: string): void {
    this.records[agentSessionId] = {
      agentSessionId,
      claudeSessionId,
      issueId,
      startedAt: new Date().toISOString(),
    };
    this.persist();
    console.log(`[session-store] Saved mapping: ${agentSessionId} → ${claudeSessionId}`);
  }

  getClaudeSessionId(agentSessionId: string): string | undefined {
    return this.records[agentSessionId]?.claudeSessionId;
  }

  getByIssueId(issueId: string): SessionRecord | undefined {
    return Object.values(this.records).find((r) => r.issueId === issueId);
  }

  private load(): void {
    try {
      const data = readFileSync(this.filePath, "utf-8");
      this.records = JSON.parse(data);
    } catch {
      // File doesn't exist yet — start fresh
      this.records = {};
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.records, null, 2));
    } catch (err) {
      console.error("[session-store] Failed to persist:", err);
    }
  }
}
