# @manta/orchestrator — Architecture

## Why this package exists

The bus is a passive data plane — it stores facts but doesn't enforce time-based invariants. Heartbeats expire, locks go stale, parent processes die. The orchestrator is the policy layer that watches those facts, decides "this clone is dead," and runs the death workflow (mark DEAD, reap, write post-mortem, emit events). Everything that needs cleanup happens here, not in the bus.

## Boundaries

- **In scope:** dead-clone detection, stale-lock reaping, expired-claim reaping, post-mortem authoring, status snapshot.
- **Out of scope:**
  - Cycle scheduling (caller decides when — a CLI tick, or a daemon)
  - Spawn / kill / abort (manta-cli)
  - Charge / cooldown ledger
  - Cross-clone merge review
  - User-facing notifications routing (handled by hooks + status line)

## Module map

| File | Responsibility |
|---|---|
| `thresholds.ts` | Tunable constants (heartbeat timeout, stale-lock cutoff, post-mortem dir, parent-PID toggle); `mergeThresholds` for partial overrides |
| `parent-pid.ts` | `process.kill(pid, 0)` probe + `PidProbe` injection seam for tests |
| `death-detector.ts` | Pure function: registry list + thresholds + probe → `DeadCloneFinding[]` |
| `lock-reaper.ts` | Calls `LocksStore.reapStale`; emits `lock_reap` events |
| `claim-reaper.ts` | Calls `ClaimsStore.reapExpired`; emits `claim_reap` events |
| `post-mortem-writer.ts` | `PostMortemWriter` interface + fs (atomic) and in-memory implementations |
| `post-mortem.ts` | Composes registry record + filtered event timeline; renders markdown; calls writer; idempotent |
| `status.ts` | `OrchestratorStatus` snapshot for `manta status` |
| `orchestrator.ts` | `Orchestrator` class — composes Chunk-1 functions into `runCycle()` |
| `errors.ts` | `OrchestratorError` with typed `kind` |

## Design choices

- **Pure functions wrapped by a class.** Each phase of a cycle (`findDeadClones`, `reapLocks`, `reapClaims`, `runPostMortem`) is a free function that takes only what it needs. The `Orchestrator` class is a thin composer; it exists for ergonomic injection of `probe` + `writer` + `thresholds` once at construction time. Tests can call the free functions directly without instantiating the class.
- **Injectable PidProbe.** Production uses `isProcessAlive` (`process.kill(pid, 0)`); tests pass a stub. Without injection, parent-PID tests would have to spawn real subprocesses, slowing the suite and making CI flaky.
- **Pluggable PostMortemWriter.** Production writes atomic markdown files; tests use `inMemoryPostMortemWriter` for assertions. Same composer in `post-mortem.ts` calls either.
- **Reapers emit events; the bus stays silent.** `LocksStore.reapStale` and `ClaimsStore.reapExpired` mutate state but do not write to the events log — the orchestrator does, so a no-op call (zero reaped) doesn't litter the log.
- **`runCycle` is idempotent on unchanged state.** A second call after the first against the same registry+locks+claims state produces zero new dead clones, zero reaped leases, zero reaped claims, zero post-mortems.
- **`runPostMortem` is re-entrant by design.** Distinct from cycle-idempotency: directly calling `runPostMortem` against an already-DEAD clone *does* write a fresh markdown document (and emits a fresh `post_mortem` event) without re-marking the clone. This is intentional so the CLI's `manta recover --post-mortem A` always produces an artifact even after a previous run, and so the post-mortem composer is decoupled from "is this the first death?" state.
- **No internal scheduling.** The cycle is single-shot. `cycleIntervalMs` is a hint to callers, not a self-driven setInterval. This keeps the orchestrator testable and stops it from owning a process lifecycle it does not have.
- **Errors wrap, don't lose.** `OrchestratorError` carries `cause` so callers can drill into the underlying bus / fs error.

## Known invariants & limitations

- **State-ahead-of-audit window for reapers.** The reaper sequence is `store.reapX() → events.append(...)`: state mutation happens first, then the audit event. If the process crashes between the two, the lease/claim is gone but no `lock_reap` / `claim_reap` event was ever recorded. The next `runCycle` finds nothing to reap (idempotent), so the gap never widens, but a single audit-event-per-reap can be missed for that one window. This is documented symmetrically in `packages/manta-bus/ARCHITECTURE.md` under "Known invariants & limitations" and is an intentional carve-out — closing it would require a two-phase commit between the bus state file and the events log, out of scope for now.
- **No `LocksStore.listAll`.** `buildStatus` aggregates lease lists across all *registered* clones via `LocksStore.listOwned(cloneId)`. Leases owned by a clone whose registry record is gone (zombies) won't show up in `getStatus()`; they surface as `lock_reap` events on the next cycle. A future `LocksStore.listAll` would let `manta status` pick them up automatically.
- **`getStatus` is not a serializable snapshot.** It calls registry / locks / claims in parallel; a concurrent `runCycle` may produce a torn read across stores. Eventual consistency: a follow-up `getStatus` after the cycle settles returns a coherent view. Callers that need a precise moment-in-time view (e.g. a post-mortem replay) should query `events.jsonl` directly instead of `getStatus`.

## Test strategy

- **Unit per module** — each Chunk-1 piece has its own suite with `FakeClock` + tmp-dir bus context.
- **Class-level tests** — `orchestrator.test.ts` exercises `runCycle` against the in-memory writer + injected probe, covering empty / heartbeat-stale / parent-dead / idempotent / error-wrap cases.
- **Integration** — `integration.test.ts` runs against a real `@manta/bus` `BusContext` over a tmp dir, with a real `fsPostMortemWriter`. Asserts all four planes: registry transitions, lock reaping, claim reaping, file artifacts on disk, events in the log.
- **Coverage** ≥ 80 % on lines/functions/branches/statements; `src/index.ts` excluded.
