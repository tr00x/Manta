---
name: manta:cost
description: Show Manta spend — per-cast cost and accumulated charges against the budget.
argument-hint: ""
allowed-tools: Bash
---

Report Manta's cost and charge ledger via the bundled binary. Run both views:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/bin/manta.cjs" cost
node "${CLAUDE_PLUGIN_ROOT}/dist/bin/manta.cjs" charges
```

`cost` summarizes spend; `charges` lists the charge ledger against the daily cap. Show the user both outputs so they can see budget headroom before casting. If either subcommand reports it is unavailable in the current phase, say so and skip it.
