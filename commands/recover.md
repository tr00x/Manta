---
name: manta:recover
description: Run one orchestrator cycle — detect zombies, reap stale locks/claims, write missing post-mortems.
argument-hint: ""
allowed-tools: Bash
---

Run a single Manta recovery cycle via the bundled binary.

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/bin/manta.cjs" recover
```

Use after a crash, a forced kill, or when `/manta:status` shows a clone whose heartbeat age looks stale. Report the recovery summary (dead clones detected, locks/claims reaped, post-mortems written). Returns 0 even when nothing was found.
