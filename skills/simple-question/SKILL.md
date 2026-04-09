---
name: simple-question
description: Workflow for questions, clarifications, and information requests. Researches the codebase and answers on the Linear ticket without making code changes.
---

# Simple Question Workflow

Use this workflow for questions, clarifications, and information requests.

**Important:** This workflow does NOT create branches, commits, or PRs. Do NOT modify any files.

## Phase 1: Investigate

1. Read the ticket to understand exactly what is being asked.
2. Search the codebase for relevant code, configurations, and documentation.
3. Use MCP tools if needed for deeper investigation:
   - Sentry (via `ToolSearch "+sentry"`) for error details and trends.
   - Metabase (via `ToolSearch "+metabase"`) for data queries.
   - Database MCP tools for direct database queries.
4. Gather enough context to give a thorough, accurate answer.

## Phase 2: Answer

Output a clear, well-structured answer:

- Answer the question directly upfront.
- Include supporting evidence: code snippets, file paths (with line numbers), config values.
- Use Linear-compatible markdown for formatting.
- If the question reveals a bug or needed improvement, note it and suggest creating a separate ticket.
