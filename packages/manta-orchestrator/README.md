# @manta/orchestrator

Lifecycle policy layer for Manta clones — detects dead/zombie clones, reaps stale locks and expired claims, writes structured post-mortems, emits observability events.

## Use

```typescript
import { Orchestrator, defaultThresholds, makeProbe, fsPostMortemWriter } from '@manta/orchestrator';
import { /* build a BusContext */ } from '@manta/bus';

const o = new Orchestrator({
  ctx: busContext,
  thresholds: defaultThresholds,
  probe: makeProbe(),
  writer: fsPostMortemWriter({ repoRoot: '/path/to/repo', postMortemDir: 'docs/post-mortems' }),
});

const result = await o.runCycle();
// result: deadClones, reapedLocks, reapedClaims, postMortems, events
```

Call `runCycle` on a tick (Phase 0d CLI) or in a daemon (Phase 5).

## Triggers

A clone is declared DEAD when any of:

- **Heartbeat staleness** — last heartbeat older than `thresholds.heartbeatTimeoutMs` (default 30 s).
- **Parent process death** — if `thresholds.parentPidCheckEnabled` is true (default), and `process.kill(parent_pid, 0)` reports the parent gone.

Both can fire together; the `reason` string is composite.

> **Phase 0 coverage of spec Sec 7.** The two triggers above collectively map to Sec 7's **TTL**, **Crash**, and **Killed** rows (a clone that ran out of time stops heartbeating; a crashed parent leaves orphans; an externally killed clone stops heartbeating). The **Failure (3 errors)** and **Drift** triggers come from inside the clone (the clone calls `manta.suicide_intent` then `manta.report_death`), and the **Success** path is owned by `manta-merge-review` (Phase 2 forking-realities). All three flow through the bus's existing `report_death` tool, so the orchestrator sees them as already-DEAD records and writes the post-mortem the same way.

## Reapers

- `lock-reaper` — calls `LocksStore.reapStale()`; emits one `lock_reap` event per reaped lease.
- `claim-reaper` — calls `ClaimsStore.reapExpired()`; emits one `claim_reap` event per expired claim.

> **State-ahead-of-audit window.** `LocksStore.reapStale()` and `ClaimsStore.reapExpired()` mutate the underlying state file *before* the orchestrator emits the corresponding `lock_reap` / `claim_reap` events. If the orchestrator process crashes between the store mutation and the events-log append, the next `runCycle` will see the lease/claim as already gone and emit nothing for it — leaving an audit-trail gap for that one window. This is documented symmetrically in `packages/manta-bus/ARCHITECTURE.md` under "Known invariants & limitations". The carve-out is intentional for Phase 0; `runCycle` is idempotent on already-reaped state, so the next tick self-heals (no double-mutation, no double-emission).

## Post-mortem

For each newly-DEAD clone, the orchestrator writes `docs/post-mortems/<YYYY-MM-DD>-<cast-id>-<clone-id>.md` with:

- Registry record snapshot (state, parent PID, worktree, last heartbeat)
- Reason string
- Filtered event timeline (only events whose `clone_id` matches)
- Effective thresholds

Post-mortems are atomic (temp-then-rename) and idempotent (safe to call twice — re-runs against an already-DEAD clone still write).

## Status

`getStatus()` returns a snapshot of clones, locks, claims, and the active thresholds. Used by `manta status` (Phase 0d).

## Errors

Cycle failures wrap the cause in `OrchestratorError` with a typed `kind` (`cycle_failed` | `post_mortem_failed` | `death_detect_failed` | `reap_failed`). The original cause is preserved on `.cause` so callers can drill in:

```typescript
import { isOrchestratorError } from '@manta/orchestrator';

try {
  await orchestrator.runCycle();
} catch (err) {
  if (isOrchestratorError(err)) {
    console.error(`[orchestrator] ${err.kind}:`, err.message, '— cause:', err.cause);
    // Decide: retry, alert, escalate. The bus is unchanged; safe to re-call runCycle.
  } else {
    throw err;
  }
}
```

`runCycle` is **fail-fast within a phase**: a thrown error is propagated wrapped in `OrchestratorError`, but earlier phases of the same cycle (e.g. `lock_reap` events, `claim_reap` events, partial post-mortem writes) may have already landed on disk. The cycle is idempotent on already-reaped state, so re-calling `runCycle` after handling the error is safe — the next pass simply skips already-DEAD clones, finds no fresh expirations, and exits clean.

## Non-goals (deferred)

- Daemon-mode runtime (Phase 5) — Phase 0 is library-only
- Charge / cooldown / budget bookkeeping (Phase 3)
- Best-of-N merge review (Phase 2 forking-realities)
- Worktree teardown (Phase 0d manta-cli)
- Notification routing / batching (Phase 11.0+ tiers)
