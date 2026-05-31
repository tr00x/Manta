---
name: manta:replay
description: Replay the timeline of a cast — phased events and per-clone summaries.
argument-hint: <castId> [--format markdown|json] [--clone <id>]
allowed-tools: Bash
---

Replay a completed cast's timeline via the bundled binary.

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/bin/manta.cjs" replay $ARGUMENTS
```

`$ARGUMENTS` is the cast id followed by optional flags, e.g. `cast-123 --clone A` to filter to one clone, or `cast-123 --format json` for raw output. This reconstructs the full phased event timeline after a cast has finished — use it for post-mortem review, not live watching (`/manta:tail` is the real-time surface). Relay the rendered timeline as-is.
