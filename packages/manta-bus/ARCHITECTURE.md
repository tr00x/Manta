# @manta/bus — Architecture

## Why this package exists

Clones and the main agent need a single place to coordinate without parsing each other's transcripts. The bus is the only shared, write-able truth between processes during a cast.

## Boundaries

- **In scope:** state stores (registry, locks, claims, contracts, events), MCP tool surface, atomic file writes, error envelopes.
- **Out of scope:**
  - Capability enforcement (PreToolUse hooks own this)
  - Charge accounting (Phase 3 — orchestrator owns the charge ledger; bus only logs deltas as events)
  - `forking-realities` Bus isolation (Phase 2)
  - Daemon-mode socket server (Phase 5)
  - Spawn / subprocess management (manta-cli)

## Module map

| File | Responsibility |
|---|---|
| `schema.ts` | Zod input schemas + inferred TS types — single source of truth for the wire format |
| `errors.ts` | Typed errors so callers narrow by class, not by string match |
| `clock.ts` | Injectable `Clock` interface; `FakeClock` for deterministic tests |
| `atomic-fs.ts` | Read-modify-write under `proper-lockfile`; JSONL append also locked |
| `state/paths.ts` | Canonical layout under `.manta/state/` |
| `state/registry.ts` | Clone records: register / heartbeat / markDead / staleSince / list / get |
| `state/locks.ts` | Heartbeat-based per-path leases; stale-cleanup at `staleAfterMs` (default 15 s) |
| `state/claims.ts` | Work-item claim board with per-claim TTL |
| `state/contracts.ts` | Per-clone JSON contracts + ack record |
| `state/events.ts` | Append-only JSONL audit log with monotonic IDs |
| `tools/parse.ts` | Generic Zod-parse helper that throws `BusValidationError` on failure |
| `tools/*.ts` | One handler module per tool family — each takes a subset of `BusContext` |
| `memory-writers.ts` | Side-effecting writes for `zk_write` / `para_append` (so `tools/memory.ts` is mockable) |
| `server.ts` | Pure assembly: `BusContext` + tool table → MCP `Server` |
| `bin/server.ts` | Executable entry — env parse, stdio transport, run forever |
| `index.ts` | Public re-exports only |

## Design choices

- **Filesystem source of truth.** Each Claude Code instance launches its own stdio MCP server subprocess; they share state by reading/writing `.manta/state/`. `proper-lockfile` enforces inter-process atomicity around read-modify-write cycles.
- **Heartbeat-based locks, not TTL.** A clone holding a lock must call `renew_lock` every 5 s. After 15 s without a renew, anyone can take the lock. Avoids the "guess the right TTL" anti-pattern.
- **Append-only events log.** Every write goes through `events.append` so the orchestrator (Phase 0c) can replay or tail the log for post-mortem and observability. The orchestrator is responsible for emitting a `lock_reap` event after each call to `LocksStore.reapStale` that returns reaped leases — the store itself stays silent so the events log doesn't get littered with no-op cleanup ticks.
- **Registration-agnostic.** The bus does NOT enforce that a clone has called `manta.register` before invoking other tools. Clone lifecycle gating (refusing tool calls from un-registered or post-mortem clones) is the orchestrator's job (Phase 0c). This keeps the bus a pure data plane and lets the orchestrator own lifecycle policy without coupling. The one exception is `manta.message`, which validates both `from_clone_id` and `to_clone_id` exist in the registry — because addressing a non-existent peer is a structural error, not a policy decision.
- **Validation at every boundary.** Tool inputs are zod-parsed before they hit a store. Stores additionally validate their own state files via the schema-aware `paths.contractFile` helper. No "trust the caller."
- **Injectable Clock.** All time-sensitive behaviour (lock GC, claim expiry, heartbeat staleness) takes a `Clock`. The test suite uses `FakeClock` to advance time in milliseconds without real waits.
- **One handler module per tool family.** Allows targeted unit tests, keeps each file under ~200 lines, and matches the spec's grouping (lifecycle / contract / work / locks / communication / memory).
- **Errors are typed, not stringly.** `BusValidationError` / `BusNotFoundError` / `BusConflictError` / `BusLockedError` / `BusStateError`. They map to MCP error-envelope categories deterministically in `serializeError`.

## Audit-trail invariant

Every state mutation that has an audit event MUST emit the event **inside the same file mutex** that protects the state file, **before** the tmp+rename commit. The contract is:

1. Acquire the file mutex for the state JSON (`registry.json`, `locks.json`, `claims.json`, or `contracts/<clone>.json`).
2. Run the mutator over the parsed state to compute `next`.
3. Append the audit event to `events.jsonl`.
4. Write `next` to a tmp file and rename it over the state file.
5. Release the mutex.

If step 3 throws, step 4 never runs — state is unchanged and the failure surfaces to the caller. The remaining race window is between a successful step 3 and a failed step 4 (e.g. disk full at rename); in that case the audit log is **ahead** of state. The orchestrator (Phase 0c) detects and reconciles such drift on replay.

Implementation: `atomic-fs.ts:atomicMutateJson` accepts an optional `auditAppend` callback that runs at step 3. Each mutating store method (`Registry.register/heartbeat/markDead`, `LocksStore.acquire/renew/release`, `ClaimsStore.claim/release`, `ContractsStore.write/ack`) accepts a corresponding `auditAppend?: () => Promise<void>` parameter and threads it to `atomicMutateJson`. Tool handlers wire the closure that calls `events.append(...)` with the appropriate event payload.

Memory writers (`memory-writers.ts:zkWrite/paraAppend`) are not JSON mutate-and-rename — they create new files (zk) or append to text files (para). They use the same write-ahead-log pattern: `auditAppend(computedPath)` runs before the filesystem write, receives the target path so the event records intent, and an audit-after / write-failed window is reconciled by the orchestrator via filesystem scan.

`tools/communication.ts` (`broadcast` / `message` / `drift_report`) and `tools/contract.ts:refresh` mutate **no state** — the events log is itself the audit log, and a single `events.append` is the atomic operation. No coupling needed.

## Known invariants & limitations

- **`manta.message` recipient TOCTOU.** `tools/communication.message` validates that both `from_clone_id` and `to_clone_id` exist in the registry at call time, but a recipient marked `DEAD` between validation and the audit-event append will receive a delivered event in `events.jsonl`. The orchestrator (Phase 0c) is responsible for filtering messages-to-DEAD at delivery time. The bus stays a pure data plane and does not retry or refuse based on liveness.
- **Audit-ahead-of-state.** See "Audit-trail invariant". A crash between event-append and state-rename leaves the audit log with an entry whose state mutation never landed. Replay-side reconciliation is the orchestrator's job.
- **Path containment.** `memory-writers.ts` asserts that every resolved write path stays under the configured `zkDir` / `paraDir`. The assertion is defense-in-depth on top of `slug()` stripping non-alphanumerics and the Zod-enforced category enum.
- **Work-claim event payload shape.** `claim_work` and `release_work` audit events record `{ item, timeout_ms }`, not the absolute `expires_at`. The audit closure runs inside the mutex before the `WorkClaim` is bound, so the absolute expiry is computed from `event.ts + timeout_ms` (same `Clock` instance). Phase 0c+ consumers reading the events log must compute expiry that way rather than expecting an `expires_at` field.

## Test strategy

- **Unit per store** — registry / locks / claims / contracts / events each get a focused suite using `FakeClock` and a tmp directory.
- **Unit per tool family** — `tools/*.test.ts` validate input parsing + happy-path delegation + error mapping.
- **Server contract** — `server.test.ts` connects an in-memory MCP client and asserts the tool table plus every error-envelope branch (validation, not_found, conflict, locked, state_error, internal_error, unknown_tool).
- **Integration** — `integration.test.ts` runs the full `recon-swarm` slice end-to-end including a server restart (filesystem persistence proof across all four stores).
- **Coverage** ≥ 80 % on lines/functions/branches/statements; `bin/*` excluded (covered by smoke run).
