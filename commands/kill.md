---
name: manta:kill
description: Mark a single clone DEAD by id and write its post-mortem.
argument-hint: <cloneId> [--reason "why"]
allowed-tools: Bash
---

Kill one Manta clone by id via the bundled binary.

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/bin/manta.cjs" kill $ARGUMENTS
```

Get the `<cloneId>` from `/manta:status`. If the CLI returns `not_found`, the id is wrong — show the user `/manta:status` output instead. The clone's worktree and locks are reaped by `/manta:recover` or the next orchestrator tick, not here.
