---
name: manta:abort
description: Emergency stop — mark every live clone DEAD and write a post-mortem for each.
argument-hint: '[--reason "why"]'
allowed-tools: Bash
---

Abort the running Manta cast via the bundled binary.

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/bin/manta.cjs" abort $ARGUMENTS
```

This is the kill switch the user reaches for when they say "stop". Report the CLI's `Aborted N clone(s).` line back. Worktrees persist after abort so partial state can be inspected; tell the user that.
