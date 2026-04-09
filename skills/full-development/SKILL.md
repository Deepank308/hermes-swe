---
name: full-development
description: End-to-end workflow for feature requests, enhancements, refactors, and tasks. Covers planning, TDD implementation, verification, integration testing, and PR creation.
---

# Full Development Workflow

Use this workflow for feature requests, enhancements, refactors, and general tasks.

## Phase 1: Understand & Plan

1. Read the Linear ticket thoroughly — understand the requirements, acceptance criteria, and any linked context.
2. Explore the relevant code to understand existing patterns and architecture.
3. Plan your approach: identify affected files, data flow, and potential edge cases.
4. Check for area-specific skills that may apply to the codebase you're working in.

## Phase 2: Implement with TDD

Invoke `superpowers:test-driven-development` and follow its methodology:

- **Red**: Write failing tests that capture the expected behavior.
- **Green**: Implement the minimum code to make tests pass.
- **Refactor**: Clean up while keeping tests green.

Keep changes focused on the ticket — do not refactor unrelated code.

## Phase 3: Verify

Invoke `superpowers:verification-before-completion` and follow its methodology:

- Run all relevant tests (unit, integration).
- Run lint and type checks on changed files.
- If any failures: fix the issue and re-verify (up to 3 attempts).
- Do NOT proceed to Phase 4 until all checks pass with evidence.

## Phase 4: Integration Testing

**This phase is mandatory when the change involves APIs, endpoints, services, middleware, or anything that runs inside Docker containers.** Skip only for pure frontend changes or isolated utility functions with no runtime dependencies.

Unit tests with mocks cannot catch runtime integration issues like:

- Middleware ordering and interaction
- Auth flows through the full stack
- Service-to-service communication
- Database session scoping in async contexts

### Steps

1. **Restart affected services** to pick up code changes. Wait for health checks to pass.

2. **Test the happy path end-to-end.** Make real HTTP requests that exercise the full flow:
   - Use `curl` to hit the actual endpoints through the running services.
   - Include authentication headers if the endpoint requires auth.
   - Verify the response status code AND body content.

   ```bash
   # Example: test an API endpoint
   curl -s -w "\nHTTP: %{http_code}" -X POST http://localhost:8080/api/v1/endpoint \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"key": "value"}'
   ```

3. **Test error paths:**
   - No auth / invalid auth → expect 401/403
   - Invalid input → expect 400/422
   - Not found → expect 404

4. **Check service logs** for unexpected errors.

5. **If issues are found:** Fix the code, re-run unit tests (Phase 3), then repeat this phase.

6. **Record evidence.** Include the key curl commands and their outputs in your summary — these prove the feature works beyond just unit tests.

## Phase 5: Commit & PR

1. Stage changed files and commit with a clear, descriptive message.
2. Push to the working branch.
3. Create a PR with:
   - Title. Include Linear Issue identifier (`[ENG-XXXX]: Adds email templates support`)
   - Description.
   - Summary of what was changed and why.
   - Test results (unit + integration).

## Phase 6: Summary

Output a concise summary:

- What was implemented.
- Key design decisions.
- Test results (unit test pass counts + integration test evidence).
- PR link.
