---
name: manta:status
description: Print the orchestrator snapshot — live clones, their state, heartbeat age, locks, and claims.
argument-hint: ""
allowed-tools: Bash
---

Show the current Manta orchestrator status via the bundled binary.

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/bin/manta.cjs" status
```

Render the CLI's table back to the user as-is. If it prints `No active clones.`, tell the user there is no cast running. Do not poll in a loop — run it once per invocation.
