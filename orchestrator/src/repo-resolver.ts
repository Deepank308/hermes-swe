import { config, getCandidateRepos } from "./config.js";
import { getLinearClient } from "./linear-activity.js";

const CONFIDENCE_THRESHOLD = 0.9;

const QUERY = `
  query IssueSuggestions($issueId: String!, $candidates: [CandidateRepository!]!, $agentSessionId: String) {
    issueRepositorySuggestions(issueId: $issueId, candidateRepositories: $candidates, agentSessionId: $agentSessionId) {
      suggestions {
        confidence
        repositoryFullName
      }
    }
  }
`;

interface SuggestionResult {
  issueRepositorySuggestions: {
    suggestions: Array<{
      confidence: number;
      repositoryFullName: string;
    }>;
  };
}

export async function resolveRepo(
  organizationId: string,
  issueId: string,
  agentSessionId?: string,
): Promise<string> {
  const candidates = getCandidateRepos();
  if (candidates.length === 0) {
    console.log(
      `[repo:resolve] No candidate repos configured, using default ${config.defaultRepo}`,
    );
    return config.defaultRepo;
  }

  const sessionSuffix = agentSessionId ? ` (session: ${agentSessionId})` : "";

  try {
    const client = await getLinearClient(organizationId);
    const result = await client.client.request<SuggestionResult, Record<string, unknown>>(QUERY, {
      issueId,
      candidates,
      agentSessionId,
    });

    const suggestions = result?.issueRepositorySuggestions?.suggestions ?? [];
    if (suggestions.length === 0) {
      console.log(
        `[repo:resolve] No suggestions returned for issue ${issueId}, using default ${config.defaultRepo}${sessionSuffix}`,
      );
      return config.defaultRepo;
    }

    const top = suggestions[0];
    const topRepo = top.repositoryFullName;
    const knownRepos = new Set(candidates.map((c) => c.repositoryFullName));

    if (top.confidence >= CONFIDENCE_THRESHOLD && knownRepos.has(topRepo)) {
      console.log(
        `[repo:resolve] Resolved ${topRepo} (confidence: ${top.confidence}) for issue ${issueId}${sessionSuffix}`,
      );
      return topRepo;
    }

    console.log(
      `[repo:resolve] Using default ${config.defaultRepo} for issue ${issueId} (top: ${topRepo} at ${top.confidence})${sessionSuffix}`,
    );
    return config.defaultRepo;
  } catch (err) {
    console.warn(
      `[repo:resolve] Failed for issue ${issueId}, using default ${config.defaultRepo}:`,
      err instanceof Error ? err.message : err,
    );
    return config.defaultRepo;
  }
}
