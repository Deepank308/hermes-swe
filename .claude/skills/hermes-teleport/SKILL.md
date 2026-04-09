---
name: hermes-teleport
description: Resume a cloud Hermes agent session locally.
disable-model-invocation: true
argument-hint: <agent-session-url-or-id>
allowed-tools: Bash
---

# Teleport — Resume Cloud Session Locally

Run the teleport script to download and set up a cloud Hermes agent session locally:

```bash
bash <skill-directory>/scripts/teleport.sh $ARGUMENTS
```

The script handles everything: fetches session metadata, validates the repo, manages git state, downloads artifacts, and remaps session files.

When the script completes, tell the user to exit this session and resume with the Claude session ID printed by the script:

```bash
/resume <claudeSessionId>
```
