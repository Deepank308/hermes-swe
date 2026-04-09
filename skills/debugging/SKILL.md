---
name: debugging
description: End-to-end workflow for bug reports, production errors, Sentry issues, and regressions. Covers investigation, reproduction, fix, verification, and PR creation.
---

# Debugging Workflow

Use this workflow for bug reports, production errors, Sentry issues, and regressions.

## Phase 1: Investigate

1. Read the ticket for error details, stack traces, Sentry links, and reproduction steps.
2. If a Sentry URL is provided: invoke `/debugging-sentry-issues` for Sentry/Metabase MCP investigation.
3. If local debugging is needed: invoke `/debug-reference` for Docker environment commands and debugging tips.
4. Invoke `superpowers:systematic-debugging` and follow its 4-phase methodology:
   - **Root cause analysis**: trace the error to its origin.
   - **Pattern analysis**: identify what conditions trigger the bug.
   - **Hypothesis formation**: form a testable theory about the cause.
   - **Implementation**: plan the minimal fix.

## Phase 2: Reproduce

1. Create a failing test that captures the bug scenario.
2. Run the test and verify it fails for the right reason (the actual bug, not a setup issue).
3. This serves as the TDD RED phase — the test defines the expected correct behavior.

## Phase 3: Fix

1. Implement a minimal, targeted fix — only address the root cause.
2. Do not refactor surrounding code or fix unrelated issues.
3. Run the failing test and verify it now passes (TDD GREEN phase).

## Phase 4: Verify

Invoke `superpowers:verification-before-completion` and follow its methodology:

- Run the broader test suite to check for regressions.
- Run lint on changed JS/TS files.
- If any failures: fix the issue and re-verify (up to 3 attempts).
- Do NOT proceed to Phase 5 until all checks pass with evidence.

## Phase 5: Commit & PR

1. Stage changed files and commit with a `Fix: <description>` message.
2. Push to the working branch.
3. Create a PR with:
   - Title. Include Linear Issue identifier (`[ENG-XXXX]: Fix <concise description>`).
   - Description including:
     - Root cause analysis.
     - What the fix does and why.
     - Test results.

## Phase 6: Summary

Output a summary:

- Root cause of the bug.
- How it was reproduced (test name/description).
- What the fix does.
- Test results (pass counts, no regressions).
- PR link.
