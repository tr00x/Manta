---
name: manta:kill
description: Mark a clone DEAD and write its post-mortem.
target: manta-cli
aliases: []
---

# /manta kill

## Usage

```
/manta kill <cloneId> [--reason "why"]
```

## Arguments

| Arg | Type | Default | Notes |
|---|---|---|---|
| `<cloneId>` | string | required | from `/manta status` |
| `--reason <text>` | string | "manual kill" | recorded in registry + post-mortem |

## Behavior

1. Looks up the clone in the registry. Throws `not_found` (exit 1) if unknown.
2. `Registry.markDead(cloneId, "kill: <reason>")`.
3. Emits a `kill` event on the bus.
4. Calls `runPostMortem` to write `docs/post-mortems/<YYYY-MM-DD>-<castId>-<cloneId>.md`.
5. Returns 0 with a summary line.

The clone's worktree and held locks are NOT touched here — `runRecoverCommand` (or the next orchestrator tick) reaps them.
