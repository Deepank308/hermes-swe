---
name: preview
description: Launch a live preview environment from .claude/launch.json. Use after git push or when the user asks to preview a specific service.
---

# Preview Launcher

Launch live preview environments accessible via public URLs (Cloudflare tunnels).

## When to use

- After pushing code that changes the UI or frontend.
- When the user explicitly asks to see a preview (e.g. "launch preview for client-js").
- When the system tells you a git push was detected.

## Steps

1. **Check for launch.json** — read `.claude/launch.json` in the workspace root. If it does not exist, tell the user that no preview configuration is available for this repository.

2. **Select configuration:**
   - If a specific config name was requested (e.g. "launch preview for client-js"), find the configuration with that `name`.
   - If no name was specified, use the configuration with `"default": true`.
   - If no default is set, use the first configuration.
   - You can list all available configurations by reading the file.

3. **Run the preview launcher:**

   ```bash
   bash /opt/agent/hermes-swe/ami/preview-launch.sh --name <config-name>
   ```

   The script reads `.claude/launch.json`, runs the configured command, and creates a Cloudflare tunnel. The preview URL is printed as the last line of stdout.

4. **Share the URL** — note the preview URL (e.g. `https://preview-*.yourdomain.com`) in your response so the user knows where to find the preview. The URL is also automatically attached to the Linear ticket.

## Notes

- The script is idempotent — safe to call multiple times. It reuses existing tunnels.
- Multiple configurations can run simultaneously. Each gets its own tunnel and URL.
- Do NOT modify `.claude/launch.json` or files in `.claude/preview/` — they are managed externally.
