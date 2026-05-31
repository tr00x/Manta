---
name: manta:inspect
description: Deep-dive into a single clone — registry, contract, locks, and recent events.
argument-hint: <cloneId> [--events <n>] [--json]
allowed-tools: Bash
---

Inspect one Manta clone in depth via the bundled binary.

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/bin/manta.cjs" inspect $ARGUMENTS
```

`$ARGUMENTS` is the clone id followed by optional flags, e.g. `A --events 20` or `A --json`. Get the `<cloneId>` from `/manta:status`. This is the per-clone counterpart to the orchestrator-wide `/manta:status` snapshot — show the user the registry record, contract, held locks, and recent events as-is. If the CLI returns `not_found`, the id is wrong — point the user at `/manta:status`.
