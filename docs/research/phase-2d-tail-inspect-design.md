# Phase 2d: `/manta inspect` and `/manta tail` Design

Spec reference: Sec 11.0 (observability tier ladder), Sec 12 (command palette).

---

## `/manta inspect <cloneId>` Design

### Purpose

Tier 2 observability — deep dive into a single clone. Answers "why is this clone slow / stuck / drifting?" by aggregating data from multiple bus stores into a structured human-readable report.

### Data sources

Each section of the output maps to one bus store read:

| Section | Store / method | Data |
|---|---|---|
| Identity | `Registry.get(cloneId)` → `CloneRecord` | clone_id, mode, state, worktree, registered_at, last_heartbeat_at, progress, death_reason, died_at |
| Contract | `ContractsStore.read(cloneId)` → `StoredContract` | task, scope (allowed/forbidden paths, maxFilesChanged), approach_hint, sibling_clones, deadline_ms, written_at, ack (interpretation + acked_at) |
| Locks | `LocksStore.listOwned(cloneId)` → `LockLease[]` | path, acquired_at, last_heartbeat_at |
| Claims | `ClaimsStore.list()` filtered by `owner_clone_id === cloneId` | item, claimed_at, expires_at |
| Recent events | `EventsLog.readAll()` filtered by `clone_id === cloneId`, last N | id, ts, type, payload (truncated) |
| Liveness | Computed: `now - last_heartbeat_at` vs `thresholds.heartbeatTimeoutMs` | heartbeat_age_ms, stale (boolean) |

No new bus methods needed — all reads are already available.

### Output format

Structured text sections, not raw JSON. Each section has a header and formatted key-value pairs or short tables.

```
╔══════════════════════════════════════════════════╗
║  Clone B — WORKING                               ║
╚══════════════════════════════════════════════════╝

── Identity ──────────────────────────────────────
  Mode:           recon-swarm
  Registered:     2026-05-26 12:16:13 UTC (4m ago)
  Last heartbeat: 3s ago (healthy)
  Worktree:       .manta/worktrees/clone-B
  Progress:       Reading source files

── Contract ──────────────────────────────────────
  Task:           Design /manta tail and /manta inspect...  (truncated at 120 chars)
  Scope:          docs/research (rw), .manta/state (forbidden)
  Max files:      5
  Deadline:       20m (15m 42s remaining)
  Siblings:       A, C
  Ack:            ✓ "Research and design..." (acked 2s after contract)

── Locks (1) ─────────────────────────────────────
  docs/research/phase-2d.md    held 2m 13s   (heartbeat 3s ago)

── Claims (0) ────────────────────────────────────
  (none)

── Recent Events (last 10) ───────────────────────
  12:16:14  register      {clone_id: B}
  12:16:15  heartbeat     state=WORKING
  12:16:17  contract_ack  interpretation="Research and design..."
  12:17:01  lock          path=docs/research/phase-2d.md
  ...
```

Key formatting decisions:
- Timestamps shown as local time + relative ("4m ago") for quick scanning
- Contract task truncated to 120 chars in default view, full in `--json`
- Locks/claims shown as inline table with duration
- Events: one line per event, payload truncated to 80 chars, most recent last (chronological)
- State shown with color in terminal: WORKING=green, BLOCKED=yellow, DEAD=red, STARTING=cyan

### CLI interface

```typescript
export interface RunInspectOptions {
  cloneId: string;
  json: boolean;           // --json flag for machine-readable output
  eventCount: number;      // --events N, default 10, max 100
  reporter: Reporter;
}
```

Argument parsing follows `promote.ts` pattern — positional `cloneId` (required), optional flags.

The `--json` flag outputs the full aggregated data as a single JSON object (no truncation). Useful for piping to `jq` or feeding into other commands. Structure:

```typescript
interface InspectOutput {
  clone: CloneRecord;
  contract: StoredContract | null;
  locks: LockLease[];
  claims: WorkClaim[];
  recentEvents: BusEvent[];
  liveness: {
    heartbeat_age_ms: number;
    stale: boolean;
    threshold_ms: number;
  };
}
```

### Edge cases

| Case | Behavior |
|---|---|
| Clone not found in registry | `CliError` with `kind: 'not_found'`, message: `clone "${id}" not found in registry` |
| Clone DEAD | Show full report including death_reason and died_at. Events still available (events log is append-only). Mark header as DEAD (red). |
| No contract yet | Contract section shows `(not yet written)`. This can happen during the window between `register` and `contracts.write` in cast.ts. |
| Contract not acked | Show contract, ack section shows `✗ (pending)`. |
| No events for this clone | Events section shows `(no events)`. |
| Multiple clones with same prefix | Exact match only. No fuzzy matching — clone IDs are single letters (A–E). |

### Function signature

```typescript
export async function runInspectCommand(
  rt: Runtime,
  opts: RunInspectOptions,
): Promise<CommandResult>
```

Follows the same `(Runtime, Options) → CommandResult` pattern as `status.ts` and `promote.ts`.

### Implementation: data assembly

```typescript
async function assembleInspectData(
  rt: Runtime,
  cloneId: string,
  eventCount: number,
): Promise<InspectOutput>
```

This function reads all stores in parallel (`Promise.all`) and assembles the `InspectOutput`. The render function (`renderInspect`) takes `InspectOutput` and produces the text output. `--json` bypasses the renderer and calls `JSON.stringify(data, null, 2)`.

Separation of assembly and rendering enables unit testing the renderer with fixture data (no bus needed).

---

## `/manta tail <cloneId> [durationSeconds]` Design

### Purpose

Tier 3 observability — real-time event stream for one clone. Answers "what is this clone doing right now?" by polling `EventsLog.readSince` and printing new events as they appear.

### Polling vs streaming

Decision: **polling with cursor**, not MCP streaming.

Rationale:
1. `EventsLog.readSince(tsExclusive)` already exists and returns events with `ts > tsExclusive`
2. MCP streaming would require a new transport layer (SSE/WebSocket) — out of scope for Phase 2d
3. Polling at 1–2s interval is sufficient for human consumption (Tier 3 is "live" in human terms, not sub-second)
4. File-based events log is the single source of truth (Sec 11.0: "единый источник истины — orchestrator's event log")

### Poll interval and duration

| Parameter | Default | Min | Max | Flag |
|---|---|---|---|---|
| Poll interval | 2000ms | 500ms | 10000ms | `--interval <ms>` |
| Duration | 300s (5 min) | 10s | 3600s (1 hour) | positional `[durationSeconds]` or `--duration <s>` |

The 5-minute default aligns with a typical clone lifecycle (spec Sec 6.2: default deadline 20 min, but most recon-swarm clones finish in 5–10 min).

### Tail loop architecture

The tail loop is a **new loop**, not a reuse of `tick-loop.ts`.

Rationale for not reusing `runTickLoop`:
1. `runTickLoop` runs `orchestrator.runCycle()` which **mutates state** (marks dead clones, reaps locks/claims, writes post-mortems). `tail` is purely read-only.
2. `runTickLoop.allDone()` checks if spawned clones are DEAD. `tail` checks if one specific clone is DEAD.
3. `runTickLoop` has error semantics (throws `CliError` on cycle failure). `tail` should tolerate read errors and retry.
4. The abstraction would need so many carve-outs ("skip cycle", "different allDone", "different error handling") that it's simpler to write a 20-line purpose-built loop.

However, the **sleep-with-abort** utility from `tick-loop.ts` (`sleep(ms, signal)`) should be extracted to a shared module (`packages/manta-cli/src/util/sleep.ts`) and reused. Both loops need the same interruptible sleep pattern.

### Tail loop pseudocode

```typescript
async function runTailLoop(opts: TailLoopOptions): Promise<void> {
  let cursor = opts.startFrom ?? Date.now();  // start from "now" by default
  const deadline = Date.now() + opts.durationMs;

  for (;;) {
    if (opts.signal?.aborted) break;
    if (Date.now() >= deadline) break;

    const events = await rt.ctx.events.readSince(cursor);
    const filtered = events.filter(e => e.clone_id === opts.cloneId);

    for (const event of filtered) {
      opts.onEvent(event);
      cursor = Math.max(cursor, event.ts);
    }

    // Check if clone is DEAD — if so, flush remaining events and exit
    if (filtered.some(e => e.type === 'post_mortem' || e.type === 'report_death')) {
      break;
    }

    // Also check registry for DEAD state (in case death event was written by orchestrator,
    // not by the clone itself — heartbeat timeout scenario)
    try {
      const record = await rt.ctx.registry.get(opts.cloneId);
      if (record.state === 'DEAD') {
        opts.onEvent({
          id: 'synthetic-death',
          ts: Date.now(),
          type: 'tail_notice',
          clone_id: opts.cloneId,
          payload: { message: `Clone ${opts.cloneId} is DEAD: ${record.death_reason ?? 'unknown'}` },
        });
        break;
      }
    } catch {
      // Clone not in registry yet — continue polling
    }

    await sleep(opts.intervalMs, opts.signal);
  }
}
```

### Output format

One line per event. Format:

```
[12:16:14.023] heartbeat     state=WORKING
[12:16:17.456] contract_ack  interpretation="Research and design /manta tail..."
[12:17:01.789] lock          path=docs/research/phase-2d.md
[12:18:33.102] broadcast     event_type=progress, data="Reading source files"
[12:19:45.678] zk_write      tags=[clone-B, cast-xxx]
```

Formatting rules:
- Timestamp: `HH:mm:ss.SSS` local time (compact, no date — tail sessions are short)
- Event type: left-padded to 14 chars for alignment
- Payload: key=value pairs extracted from payload object, truncated at 80 chars per line
- Color: event types color-coded (heartbeat=dim, broadcast=cyan, lock/unlock=yellow, error/death=red)
- No `--json` for tail — events are already one-per-line; pipe through `jq` if needed (raw JSON per line with `--raw` flag)

### CLI interface

```typescript
export interface RunTailOptions {
  cloneId: string;
  durationMs: number;      // from positional arg or --duration, default 300_000
  intervalMs: number;      // --interval, default 2000
  raw: boolean;            // --raw: output raw JSON per line instead of formatted
  reporter: Reporter;
}
```

### Exit conditions

| Condition | Behavior |
|---|---|
| Duration elapsed | Print `--- tail ended (duration elapsed: 300s) ---` and exit 0 |
| Clone DEAD | Print death notice and exit 0 (successful observation of a lifecycle) |
| Ctrl+C (SIGINT) | Graceful exit via AbortController, print `--- tail interrupted ---`, exit 0 |
| Clone not found | If clone never appears in registry within first 10s, `CliError` with `kind: 'not_found'` |
| Read error | Log warning, continue polling (transient FS errors shouldn't kill the tail) |

### Function signature

```typescript
export async function runTailCommand(
  rt: Runtime,
  opts: RunTailOptions,
): Promise<CommandResult>
```

### `readSince` performance note

Current `EventsLog.readSince` reads the entire JSONL file and filters. For a typical cast (hundreds of events), this is fine. For Phase 3+ with thousands of events per cast, consider adding a `readSinceLineOffset` method that seeks into the file. But for Phase 2d: **no optimization needed** — premature optimization for a read-only observability command is waste.

---

## Shared Infrastructure Needs

### New utilities to extract/create

| Item | Source | Destination | Rationale |
|---|---|---|---|
| `sleep(ms, signal)` | `tick-loop.ts:43-56` | `packages/manta-cli/src/util/sleep.ts` | Both `runTickLoop` and tail loop need interruptible sleep. Extract, not duplicate. |
| `formatTimestamp(ts)` | new | `packages/manta-cli/src/output/format.ts` | Shared between inspect (relative timestamps) and tail (HH:mm:ss.SSS). |
| `formatRelativeTime(ms)` | new | `packages/manta-cli/src/output/format.ts` | "4m ago", "3s ago" — used by inspect identity and locks sections. |
| `truncate(s, maxLen)` | new | `packages/manta-cli/src/output/format.ts` | Truncate strings with `...` suffix. Used by both inspect (task, payload) and tail (payload). |
| `renderInspect(data)` | new | `packages/manta-cli/src/output/inspect-renderer.ts` | Pure function: `InspectOutput → string`. Testable with fixtures. |
| `formatTailEvent(event)` | new | `packages/manta-cli/src/output/tail-formatter.ts` | Pure function: `BusEvent → string`. One line per event. |

### No new EventsLog methods needed

`readAll()` and `readSince(tsExclusive)` cover both commands. `inspect` uses `readAll()` with filter + slice (last N). `tail` uses `readSince(cursor)` with filter. No new store methods required.

### No new orchestrator methods needed

`inspect` reads bus stores directly (not via `getStatus`) because it needs data `getStatus` doesn't expose (contract, events, per-clone locks). `getStatus` is a Tier 1 aggregate view; `inspect` is Tier 2 with different data shape.

### CLI registration pattern

Both commands register in the same place as `status` and `cast`. Looking at the codebase structure:

- `packages/manta-cli/src/commands/inspect.ts` — `runInspectCommand`
- `packages/manta-cli/src/commands/tail.ts` — `runTailCommand`
- Both follow `(Runtime, Options) → Promise<CommandResult>` pattern
- Both are pure reads — no state mutations, exit code always 0 (except `not_found`)

---

## Test Strategy

### Unit tests (no bus, no FS)

| Test file | Tests | Fixture data |
|---|---|---|
| `inspect-renderer.test.ts` | Render all sections with mock `InspectOutput` data. Verify header, identity, contract, locks, claims, events sections present and formatted. Test edge cases: DEAD clone shows death_reason, no contract shows placeholder, empty events, truncated task. | Hardcoded `InspectOutput` objects |
| `tail-formatter.test.ts` | Format individual events. Verify timestamp format, type alignment, payload truncation, `--raw` JSON output. | Hardcoded `BusEvent` objects |
| `format.test.ts` | `formatTimestamp`, `formatRelativeTime`, `truncate` utilities. | Scalar inputs |

### Integration tests (in-memory bus)

| Test file | Tests |
|---|---|
| `inspect.test.ts` | Full `runInspectCommand` with in-memory bus. Register a clone, write contract, add locks/claims/events, verify output contains all sections. Test `--json` flag produces valid JSON. Test `not_found` error. |
| `tail.test.ts` | Full `runTailCommand` with in-memory bus. Append events to EventsLog, verify tail picks them up. Test exit on clone DEAD. Test duration timeout. Test `--raw` output. Use short intervals (100ms) and durations (1s) for fast tests. |

### What NOT to test

- No e2e tests (spawning real Claude processes) — these are read-only commands, e2e adds no value over integration
- No performance tests for `readSince` — premature; hundreds of events is the Phase 2d ceiling
- No snapshot tests for exact output formatting — fragile, breaks on any cosmetic change. Assert structure (sections present, key fields visible), not exact strings.

### Test doubles

Both commands use `Runtime` which contains `BusContext`. Tests can use the existing in-memory test harness pattern from `packages/manta-bus/src/test-helpers/` (if one exists) or construct stores with `busPaths(tmpDir)` + `systemClock` as the status/cast tests do.

The tail test needs to simulate "events arriving over time" — use a `FakeClock` that advances on each poll iteration, and append events to the EventsLog between poll cycles.

### Coverage target

80%+ on all new files (per CLAUDE.md quality bar). The pure renderer/formatter functions are easy to cover exhaustively; the command functions are integration-tested. The shared `sleep` utility is already tested via `tick-loop.test.ts`.

---

## Implementation order

1. Extract `sleep` utility from `tick-loop.ts` → `util/sleep.ts` (refactor, no behavior change)
2. Create `output/format.ts` with `formatTimestamp`, `formatRelativeTime`, `truncate`
3. Implement `inspect` command (simpler: single read, no loop)
4. Implement `tail` command (uses polling loop + formatter)
5. Wire both into CLI entry point
6. Tests for all of the above

Estimated scope: ~400 LOC new code + ~300 LOC tests.
