# Last-gasp report — clone C, cast-1780055173473

**Task:** Phase 7c Chunk 2 (Tasks 2.1/2.2/2.3) + bug #54 audit-trail must-fix.
**Mode:** forking-realities (sibling: D). **Deadline:** 1200 s.

## Summary

Delivered the bug #54 must-fix and Task 2.1 fully — both TDD'd, gate-clean
(typecheck + lint + targeted vitest green), and committed atomically on the
worktree branch. Tasks 2.2/2.3 (`spawnCast` seam extraction + provenance write)
were **not started**: they are a ~600-line refactor of `runCastCommand` whose
plan interface is internally inconsistent (see below), and I hit the 20-minute
deadline. I chose to bank two fully-verified commits rather than leave a
half-finished, unverifiable `spawnCast` refactor that would break the cast
regression suite exactly as the orchestrator reaps — that would be a net-negative
deliverable under the "fix or revert, no half-finished" quality bar.

## Done (committed, verified)

- **Bug #54 — trigger store audit-trail pairing** (commit `fix(bus): bug #54 …`):
  - `TriggersArmedStore` + `TriggerCircuitStore` now take a **required** `EventsLog`
    ctor dep and thread `auditAppend` closures through `atomicMutateJson`, so every
    durable transition pairs with an `events.jsonl` append **inside the file mutex**
    (bug #24 invariant). A throwing append rolls back the state mutation.
  - Event types emitted: `trigger_armed`, `trigger_disarmed` (incl. aggregate
    disarm-all), `trigger_disarmed_by_validation_error` (only the 3rd/disarming
    error), `trigger_circuit_opened` (budget-burst + depth-breach trips),
    `trigger_circuit_reset` (now persists its previously-`void`'d `reason`).
  - New `tests/state/trigger-stores-audit-trail.test.ts`: 12 tests asserting both
    **emission** and **mutex-coupling rollback** (ThrowingEventsLog → mutation
    rejects, state unchanged) for each of the five event types.
  - Updated Chunk-1 tests (`triggers-armed.test.ts`, `triggers-circuit.test.ts`)
    for the new required ctor arg via shared helpers.
- **Task 2.1 — wire trigger stores into ctx** (commit `feat(cli,bus): … Task 2.1`):
  - Added `triggersArmed/triggerFires/triggerDebounce/triggerCircuit` to `BusContext`
    (**optional**, per the `workQueue?` bug-#20 idiom: handler tests use `Pick`/partial
    ctx literals; production literals always construct them).
  - Constructed in both production ctx literals: `createRuntime` (CLI) and the MCP
    `server.ts`. Armed + Circuit share the runtime's single `EventsLog` instance.
  - Runtime regression test asserts all four present + a circuit trip writes
    `trigger_circuit_opened` to the repo `events.jsonl` end-to-end.

Verification run locally: `@manta/bus` full suite green (452 tests after
`pnpm -r build`); `manta-cli` `runtime.test.ts` green; both packages typecheck
clean; eslint clean on all changed files.

## NOT done — Tasks 2.2 / 2.3 (`spawnCast` seam + provenance)

**Pending. Recommend a fresh cast with a clarified contract.** Two blockers found:

1. **Time** — hit the 20-min deadline after bug #54 + 2.1. The `spawnCast`
   extraction touches ~600 lines of `runCastCommand` (`packages/manta-cli/src/
   commands/cast.ts:236`) and demands a full cast-suite regression pass to claim
   done; not safely completable in the residual minutes.
2. **Plan inconsistency (flag for the planner)** — Task 2.2's stated
   `SpawnCastOptions` interface omits `runner`, `reporter`, `cycleIntervalMs`,
   `tickBudgetMs`, `castId`, `cloneAssignments`, yet the prose says "the spawn
   (`spawnClone`) moves into `spawnCast`" and the tick-loop/merge-review/settlement
   all live downstream in `runCastCommand`. The narrow `CastSpawnResult`
   (`{castId, spawnedClones, estimatedCostUsd}`) cannot carry the `handles`/
   `worktrees` that `runCastCommand` needs to run the tick loop afterward. So the
   boundary is under-specified: either (a) `spawnCast` wraps the **entire**
   lifecycle and `runCastCommand` becomes a thin `CommandResult` adapter, or
   (b) `spawnCast` returns handles+worktrees+orchestrator-inputs (wider than the
   plan's result type) and `runCastCommand` continues. **Recommendation: (a)** —
   it best preserves the safety invariant the task exists for ("no second spawn
   implementation, gate cannot be bypassed"), since the trigger fire path (Chunk 3)
   wants the full gated lifecycle, not just spawn. The contract should be amended
   before implementation (CLAUDE.md: "Расхождение → правим спек явно").

The bug #54 + Task 2.1 work is independent of 2.2/2.3 and merges cleanly on its own.

## Self-certainty

7/10 on the delivered scope (bug #54 + 2.1): clean, TDD'd, gate-verified, no
hacks. Lower than 9 only because Chunk 2 is 2/3 incomplete by task count.
