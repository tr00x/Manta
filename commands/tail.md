---
name: manta:tail
description: Stream a single clone's events live for on-demand deep watch (Tier 3 observability).
argument-hint: "<cloneId> [durationSeconds]"
allowed-tools: Bash
---

Stream events for one clone in real-time via the bundled binary. This is the Tier 3 (real-time) observability surface — use it when the user wants to watch a specific clone move ход-by-ход, not just the snapshot `/manta:status` gives.

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/bin/manta.cjs" tail $ARGUMENTS
```

`$ARGUMENTS` is the clone id followed by optional flags, e.g. `A 120` to tail clone `A` for 120 seconds, or `A --raw` for raw JSON lines. With no duration it streams for the default window. Relay the streamed output to the user as-is; the binary stops itself when the duration elapses.
