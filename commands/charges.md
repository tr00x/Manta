---
name: manta:charges
description: Show the charge system state — current charges, cooldown, and mode availability.
argument-hint: ""
allowed-tools: Bash
---

Report Manta's charge and cooldown ledger via the bundled binary.

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/bin/manta.cjs" charges $ARGUMENTS
```

Show the user the current charges, any active cooldown, and which modes are available right now. This is the cooldown-focused view that complements `/manta:cost` (spend summary) — use it before a cast to check you have charge headroom. If it reports it is unavailable in the current phase, say so.
