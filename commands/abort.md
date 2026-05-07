---
name: manta:abort
description: Mark every live clone DEAD and write a post-mortem each.
target: manta-cli
aliases: []
---

# /manta abort

## Usage

```
/manta abort [--reason "why"]
```

## Arguments

| Arg | Type | Default | Notes |
|---|---|---|---|
| `--reason <text>` | string | "user-abort" | applied to every live clone |

## Behavior

1. Reads every clone in the registry.
2. For each clone whose state ≠ DEAD: `markDead("abort: <reason>")`, emit `abort` event, run `runPostMortem`.
3. Already-DEAD clones are skipped (their `death_reason` is preserved).
4. Returns 0 with `Aborted N clone(s).`

Worktrees persist after abort so the operator can inspect partial state.
