---
name: manta:cast
description: Spawn N clones for a given mode. Phase 0 supports recon-swarm only.
target: manta-cli
aliases: []
---

# /manta cast

## Usage

```
/manta cast <mode> [--clones N] [--task "task description"]
```

Mode is required. Phase 0: `recon-swarm` only. Other modes throw `invalid_input`.

## Arguments

| Arg | Type | Default | Notes |
|---|---|---|---|
| `<mode>` | string | required | `recon-swarm` (Phase 0) |
| `--clones <n>` | integer 1..5 | 2 | Phase-0 ceiling 5 |
| `--task <desc>` | string | "unspecified" | passed into each clone's task contract |
| `--cycle-interval-ms <ms>` | integer > 0 | 5000 | orchestrator cycle interval |
| `--tick-budget-ms <ms>` | integer > 0 | 1500000 (25 min) | aborts the cast after this |
| `--budget-per-clone-usd <amt>` | number > 0 | 5 | dollarsTotal in each clone's snapshot |
| `--budget-per-cast-usd <amt>` | number > 0 | 15 | cumulative dollar cap; rejects with `invalid_input` if `cloneCount × budget-per-clone-usd > this` |

## Behavior

Delegates to `runCastCommand` (in `@manta/cli`). For each clone:
1. Creates a worktree at `.manta/worktrees/clone-<id>` on branch `manta/<castId>/<id>`.
2. Builds a `Snapshot` via `@manta/snapshot.captureState` and writes it to `.manta/snapshots/<castId>/<id>.snapshot.json`.
3. Writes the `taskContract` to the bus via `manta.task_contract.write`.
4. Pre-registers the clone via `Registry.register` then spawns the clone process (production: `claude --print --append-system-prompt <priming-text> --permission-mode bypassPermissions <initial-prompt>`; tests: a fake-clone fixture).
5. Runs the orchestrator's tick loop until either every spawned clone is DEAD or `tickBudgetMs` elapses.
6. On exit: returns 0 (success or budget-aborted) with a summary; non-zero on `cast_failed`.

Worktrees stay on disk after the cast for inspection. `manta abort` and Phase-7 `/manta exhume` manage retention.
