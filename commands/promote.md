---
name: manta:promote
description: Merge the winning candidate from a forking-realities cast and graveyard the losers.
argument-hint: <castId>/<cloneId>
allowed-tools: Bash
---

Promote the winning clone of a forking-realities cast via the bundled binary.

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/bin/manta.cjs" promote $ARGUMENTS
```

The argument is `<castId>/<cloneId>` (e.g. `cast-1234567890/B`) — usually the winner named in `docs/merge-reviews/cast-<id>.md`. If the CLI reports a merge conflict (`cast_failed`), tell the user to resolve it manually; do not retry blindly.
