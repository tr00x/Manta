# Phase 2d: Observability Tier 2-4 — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `manta inspect`, `manta tail`, `manta replay`, and `manta audit` — completing Spec Sec 11.0's five-tier observability ladder (Tiers 2-4). Fix bug #12 (forensic timeline JSON produced only in e2e harness, not in production casts) by extracting `ForensicTimeline` into `@manta/orchestrator` and wiring it into the orchestrator cycle. Add a forking-realities e2e test that validates the full cast lifecycle including merge-review.

**Architecture:** Two chunks. Chunk 1 lands **shared infrastructure + inspect + tail** in `@manta/cli` — sleep extraction, formatting utilities, two new read-only commands with pure-function renderers. Chunk 2 lands **ForensicTimeline (bug #12 fix) + replay + audit + forking-realities e2e** — orchestrator-side timeline recording, two forensic commands in both `@manta/orchestrator` (data assembly) and `@manta/cli` (argv + output), and the FR e2e test in `@manta/e2e`.

**Tech Stack:** TypeScript 5.x strict, Node 20+, `vitest`. Zero new runtime dependencies. All four commands are pure reads — they never mutate bus state, only read from existing stores and render output.

---

## Why two chunks (and not one, and not three)

Chunk 1 (inspect + tail) and Chunk 2 (replay + audit + FR e2e) split at the forensic boundary:

- **Chunk 1** is single-clone, live-state commands. They read existing stores directly, need no new orchestrator modules, and can be fully tested with in-memory bus fixtures. The sleep extraction + formatting utilities are shared infrastructure both chunks consume.
- **Chunk 2** crosses into forensic territory — cast-level timeline reconstruction, cross-clone interleaving, gap analysis. It adds new modules to `@manta/orchestrator` (ForensicTimeline, replay, audit) and the FR e2e test depends on the full Phase 2c merge-review pipeline.

Splitting further (3+ chunks) would fragment the forensic commands across commits without meaningful review-isolation benefit — replay and audit share the same event-filtering patterns, and the FR e2e test validates both alongside ForensicTimeline.

---

## Scope

In-scope (Phase 2d):

- **`manta inspect <cloneId>`** (Tier 2) — deep-dive into a single clone: registry record, contract, locks, claims, recent events, liveness status. `--json` flag for machine-readable output. `--events N` to control event count (default 10).
- **`manta tail <cloneId> [durationSeconds]`** (Tier 3) — real-time polling of events for one clone. Own polling loop (not reusing tick-loop — tail is read-only, tick-loop mutates state). `--interval`, `--raw` flags. Exits on clone DEAD, duration elapsed, or Ctrl+C.
- **`manta replay <castId>`** (Tier 4) — post-cast forensic timeline across all clones in a cast. Interleaved chronological view with lifecycle phase grouping (spawn, working, death, review). `--format json`, `--clone` filter. Data assembly in `@manta/orchestrator`, CLI argv in `@manta/cli`.
- **`manta audit <cloneId>`** (Tier 4) — action audit log for a single clone with relative timestamps, inter-event gap analysis, type filters. `--type`, `--gaps`, `--limit`, `--format json` flags. Data assembly in `@manta/orchestrator`, CLI argv in `@manta/cli`.
- **Bug #12 fix** — `ForensicTimeline` extracted from e2e harness into `@manta/orchestrator`. Orchestrator `runCycle` appends a `TimelineSnapshot` per cycle. Sealed on cast completion. `manta replay` consumes production timeline as primary data source.
- **Forking-realities e2e test** — end-to-end test with real `claude --print` clones: 2 clones get distinct approaches, produce diffable output, merge-review scores them. Validates merge-review event, post-mortems, ZK notes, forensic timeline, and distinct clone assignments.
- **Sleep extraction** — `sleep(ms, signal)` extracted from `tick-loop.ts` to `packages/manta-cli/src/util/sleep.ts`, reused by both tick-loop and tail.
- **Formatting utilities** — `formatTimestamp`, `formatRelativeTime`, `truncate` in `packages/manta-cli/src/output/format.ts`, shared by inspect and tail renderers.

Out of scope (deferred):

- **LocksStore.listAll()** — status and inspect work around via `listOwned(cloneId)` per registered clone. Phase 3+.
- **EventsLog indexing / cursor API** — `readAll()` + `readSince(tsExclusive)` are sufficient for Phase 2d event volumes (<500 events per cast). Phase 3+ daemon-mode may need cursor/offset.
- **Event filtering convenience methods** (`readByClone`, `readByCast`) — each consumer post-filters. Adding convenience methods is Phase 3+ polish.
- **Graveyard retention reaper** — Phase 4+ or Phase 7 `manta exhume`.
- **Terminal colour output** — renderers produce plain text. Phase 3+ can add chalk/ansi if warranted.

---

## Spec & research alignment

| Spec / research anchor | Demand | This plan's response |
|---|---|---|
| Spec Sec 11.0 Tier 2 | `manta inspect <id>` — "почему этот клон тормозит" | `inspect` aggregates registry + contract + locks + claims + recent events + liveness |
| Spec Sec 11.0 Tier 3 | `manta tail <id> [seconds]` — "хочу видеть каждый ход" | `tail` polls `readSince` with cursor, one line per event, exits on DEAD |
| Spec Sec 11.0 Tier 4 | `manta replay <cast-id>` + `manta audit <clone-id>` — "разбор после fact'а" | Both commands: data assembly in orchestrator, rendering in CLI |
| Spec Sec 11.0 mandate | "Единый источник истины — orchestrator's event log" | All four commands read from `events.jsonl` via `EventsLog` |
| Spec Sec 11.0 mandate | "Каждый tier — отдельный код-путь, не переизобретают друг друга" | Each command is a separate file, no code sharing beyond format utilities |
| Bug #12 | Forensic timeline JSON produced only by e2e harness | `ForensicTimeline` extracted to `@manta/orchestrator`, consumed by production + e2e |
| Research §tail-design | Tail uses own polling loop, not tick-loop | Separate `runTailLoop` with read-only semantics |
| Research §inspect-design | `(Runtime, Options) → CommandResult` pattern | Same pattern as `status.ts`, `promote.ts` |
| Research §replay-design | Interleaved chronological timeline with lifecycle phases | `reconstructTimeline` groups events into spawn/working/death/review |
| Research §audit-design | Per-clone audit with gap analysis | `buildAuditLog` computes relative offsets and inter-event gaps |
| Research §FR-e2e | 2-clone forking-realities with distinct approaches | e2e test with assignment-based approach differentiation |

---

## Quality bar (CLAUDE.md / spec Sec 14)

- Test coverage >= 80% statements/branches on every new/modified file.
- TDD per task: failing test -> run -> minimal impl -> re-run -> commit.
- No `// TODO`, `// FIXME`, `it.skip`, `test.skip` in merged code.
- Atomic conventional commits, `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` in each.
- Ships with: docs committed atomically with the code.
- No lint warnings.
- Plan reviewer subagent must approve each chunk before it executes.

---

## Reference docs

- Source-of-truth design: `docs/superpowers/specs/2026-05-06-manta-pattern-design.md` — Sec 11.0 (observability tiers), Sec 12 (command palette), Sec 14 (production quality).
- Predecessor plans: `2026-05-08-phase-2c-merge-review.md` (merge-review pipeline — Phase 2d's replay/audit consume merge-review events; FR e2e depends on it).
- Phase 2d research: `docs/research/phase-2d-observability-infra-map.md` (data sources, consumers, gaps), `docs/research/phase-2d-tail-inspect-design.md` (inspect + tail), `docs/research/phase-2d-replay-audit-e2e-design.md` (replay + audit + FR e2e).
- Project rules: `CLAUDE.md` — Quality bar (PROD only), Git rules.

---

## Chunks

1. **Chunk 1 — Shared Infrastructure + inspect + tail.** Extract `sleep` to `util/sleep.ts`. Create `output/format.ts` (timestamp + relative time + truncate). `inspect` command: data assembly + renderer + CLI wiring. `tail` command: polling loop + event formatter + CLI wiring. Wire both into `bin/manta.ts`. Full test suite.
2. **Chunk 2 — ForensicTimeline (bug #12) + replay + audit + FR e2e.** `ForensicTimeline` in `@manta/orchestrator` (append + seal + read). Wire into orchestrator `runCycle`. `replay` command: timeline reconstruction in orchestrator + CLI command. `audit` command: audit log assembly in orchestrator + CLI command. Event fixture factory for tests. FR e2e test. Wire commands into `bin/manta.ts`. Docs. Bug #12 status update.

---

## Chunk 1: Shared Infrastructure + inspect + tail

**Goal of this chunk:** The operator can run `manta inspect <cloneId>` to get a deep-dive on one clone, and `manta tail <cloneId>` to watch live events. Both are read-only commands following the `(Runtime, Options) -> CommandResult` pattern. Shared sleep and formatting utilities are extracted for reuse across both chunks.

**Files (new):**
- Create: `packages/manta-cli/src/util/sleep.ts` — interruptible sleep utility.
- Create: `packages/manta-cli/src/output/format.ts` — `formatTimestamp`, `formatRelativeTime`, `truncate`.
- Create: `packages/manta-cli/src/commands/inspect.ts` — `runInspectCommand`.
- Create: `packages/manta-cli/src/commands/tail.ts` — `runTailCommand` + `runTailLoop`.
- Create: `packages/manta-cli/src/output/inspect-renderer.ts` — `renderInspect` (pure function).
- Create: `packages/manta-cli/src/output/tail-formatter.ts` — `formatTailEvent` (pure function).
- Create: `packages/manta-cli/tests/commands/inspect.test.ts`.
- Create: `packages/manta-cli/tests/commands/tail.test.ts`.
- Create: `packages/manta-cli/tests/output/inspect-renderer.test.ts`.
- Create: `packages/manta-cli/tests/output/tail-formatter.test.ts`.
- Create: `packages/manta-cli/tests/output/format.test.ts`.
- Create: `packages/manta-cli/tests/util/sleep.test.ts`.

**Files (modified):**
- Modify: `packages/manta-cli/src/tick-loop.ts` — remove inline `sleep`, import from `util/sleep.ts`.
- Modify: `packages/manta-cli/src/bin/manta.ts` — wire `inspect` and `tail` commands.

### File size sanity check

`sleep.ts` projected ~15 LOC (extract from tick-loop.ts lines 43-56). `format.ts` projected ~60 LOC (3 utility functions). `inspect.ts` projected ~80 LOC (data assembly + command wrapper). `inspect-renderer.ts` projected ~100 LOC (structured text sections). `tail.ts` projected ~90 LOC (polling loop + command wrapper). `tail-formatter.ts` projected ~50 LOC (one-line event formatting). Test files ~100-180 LOC each. None crosses unwieldy.

### Tasks

#### Task 1.1 — Extract `sleep` utility from tick-loop

**What:** Extract the `sleep(ms, signal)` function from `packages/manta-cli/src/tick-loop.ts:43-56` to `packages/manta-cli/src/util/sleep.ts`. Update `tick-loop.ts` to import from the new location.

**Why:** Both `runTickLoop` and the tail polling loop need interruptible sleep. Extract, not duplicate.

**How:**

- [ ] Create `packages/manta-cli/src/util/sleep.ts`:
  ```ts
  export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const onAbort = (): void => {
        clearTimeout(t);
        resolve();
      };
      const t = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  ```
- [ ] Modify `packages/manta-cli/src/tick-loop.ts`: remove `function sleep(...)` (lines 43-56), add `import { sleep } from './util/sleep.js';`.
- [ ] Create `packages/manta-cli/tests/util/sleep.test.ts`: resolves after ms; resolves immediately on pre-aborted signal; resolves early on mid-sleep abort.
- [ ] Run `pnpm --filter @manta/cli test` — verify all existing tick-loop tests still green.

**TDD sequence:** Write sleep tests first, then extract, then verify tick-loop tests pass.

**Acceptance:** `sleep` lives in `util/sleep.ts`, imported by `tick-loop.ts`. All existing tests green. New sleep tests green.

---

#### Task 1.2 — Formatting utilities

**What:** Create `packages/manta-cli/src/output/format.ts` with shared formatting functions for inspect and tail.

**How:**

- [ ] `formatTimestamp(ts: number): string` — returns `HH:mm:ss.SSS` in local time. Used by tail for compact per-event timestamps.
- [ ] `formatRelativeTime(ms: number): string` — returns human-readable relative time: `"3s ago"`, `"4m 12s ago"`, `"1h 5m ago"`. Used by inspect for heartbeat age and lock durations.
- [ ] `truncate(s: string, maxLen: number): string` — truncates with `...` suffix if `s.length > maxLen`. Used by inspect (contract task, event payloads) and tail (payload display).
- [ ] `formatOffsetSeconds(baseTs: number, eventTs: number): string` — returns `"+0.0s"`, `"+45.3s"`, `"+2m 15.0s"` offset from a base timestamp. Used by replay and audit relative timestamps.
- [ ] Create `packages/manta-cli/tests/output/format.test.ts`:
  - `formatTimestamp`: known epoch -> expected `HH:mm:ss.SSS` string.
  - `formatRelativeTime`: 0ms -> `"0s ago"`, 3000ms -> `"3s ago"`, 252_000ms -> `"4m 12s ago"`, 3_900_000ms -> `"1h 5m ago"`.
  - `truncate`: short string unchanged; long string truncated with `...`; exact boundary.
  - `formatOffsetSeconds`: 0 -> `"+0.0s"`, 45_300ms -> `"+45.3s"`, 135_000ms -> `"+2m 15.0s"`.

**Acceptance:** All formatting functions exported and tested. Pure functions, no I/O.

---

#### Task 1.3 — Inspect: data assembly and renderer

**What:** Create the inspect command's data assembly logic and pure-function renderer.

**How:**

- [ ] Create `packages/manta-cli/src/output/inspect-renderer.ts`:

  Define `InspectOutput`:
  ```ts
  import type { CloneRecord, StoredContract, LockLease, WorkClaim, BusEvent } from '@manta/bus';

  export interface InspectOutput {
    clone: CloneRecord;
    contract: StoredContract | null;
    locks: LockLease[];
    claims: WorkClaim[];
    recentEvents: BusEvent[];
    liveness: {
      heartbeatAgeMs: number;
      stale: boolean;
      thresholdMs: number;
    };
  }
  ```

  Implement `renderInspect(data: InspectOutput): string`:
  - **Header:** Clone ID + state (e.g. `Clone B — WORKING`).
  - **Identity section:** mode, registered_at (formatted + relative), last heartbeat (relative + healthy/stale), worktree, progress (if present).
  - **Contract section:** task (truncated at 120 chars), scope (allowed/forbidden paths, max files), deadline (total + remaining), siblings, ack status. Show `(not yet written)` if contract is null.
  - **Locks section:** path, held duration, heartbeat age per lock. Show `(none)` if empty.
  - **Claims section:** item, claimed_at, expires_at per claim. Show `(none)` if empty.
  - **Recent events section:** one line per event — timestamp (local), type, payload (truncated at 80 chars). Chronological (oldest first).
  - Uses `formatRelativeTime` and `truncate` from `format.ts`.

- [ ] Create `packages/manta-cli/tests/output/inspect-renderer.test.ts`:
  - Render with all sections populated — verify header, identity, contract, locks, claims, events sections present.
  - Render with DEAD clone — verify death_reason and died_at shown.
  - Render with null contract — verify `(not yet written)` placeholder.
  - Render with empty events — verify `(no events)` placeholder.
  - Render with long task — verify truncation at 120 chars.
  - Test does NOT assert exact string output (fragile) — asserts section presence and key field visibility via `includes()` / regex.

**Acceptance:** Renderer is a pure function, fully testable with fixture data. No bus dependency.

---

#### Task 1.4 — Inspect: command implementation + CLI wiring

**What:** Create the `manta inspect <cloneId>` command and wire it into `bin/manta.ts`.

**How:**

- [ ] Create `packages/manta-cli/src/commands/inspect.ts`:

  ```ts
  import type { Runtime } from '../runtime.js';
  import type { Reporter } from '../output/reporter.js';
  import type { CommandResult } from './status.js';
  import { CliError } from '../errors.js';
  import { renderInspect, type InspectOutput } from '../output/inspect-renderer.js';

  export interface RunInspectOptions {
    cloneId: string;
    json: boolean;
    eventCount: number;
    reporter: Reporter;
  }

  export async function runInspectCommand(
    rt: Runtime,
    opts: RunInspectOptions,
  ): Promise<CommandResult> { ... }
  ```

  Implementation:
  - Call `rt.ctx.registry.get(opts.cloneId)` — on `BusNotFoundError`, throw `CliError` with `kind: 'not_found'`, message `clone "${id}" not found in registry`.
  - Read in parallel (`Promise.all`):
    - `rt.ctx.registry.get(opts.cloneId)` -> `CloneRecord`
    - `rt.ctx.contracts.read(opts.cloneId)` -> `StoredContract | null` (catch `BusNotFoundError` -> null)
    - `rt.ctx.locks.listOwned(opts.cloneId)` -> `LockLease[]`
    - `rt.ctx.claims.list()` -> filter by `owner_clone_id === cloneId`
    - `rt.ctx.events.readAll()` -> filter by `clone_id === cloneId`, slice last N (N = `opts.eventCount`, default 10, max 100)
  - Compute liveness: `heartbeatAgeMs = rt.ctx.clock.now() - clone.last_heartbeat_at`, `stale = heartbeatAgeMs > rt.thresholds.heartbeatTimeoutMs`.
  - Assemble `InspectOutput`.
  - If `opts.json` -> `JSON.stringify(data, null, 2)`.
  - Otherwise -> `renderInspect(data)`.
  - Return `{ exitCode: 0, stdout }`.

- [ ] Modify `packages/manta-cli/src/bin/manta.ts`:
  - Add import: `import { runInspectCommand } from '../commands/inspect.js';`
  - Add command registration after the `promote` command:
    ```ts
    program
      .command('inspect <cloneId>')
      .description('Deep-dive into a single clone: registry, contract, locks, events')
      .option('--json', 'output as JSON', false)
      .option('--events <n>', 'number of recent events to show', '10')
      .action(async (cloneId: string, options: { json: boolean; events: string }) => {
        await runWithRuntime((rt) =>
          runInspectCommand(rt, {
            cloneId,
            json: options.json,
            eventCount: Math.min(parseInt(options.events, 10) || 10, 100),
            reporter,
          }),
        );
      });
    ```

- [ ] Create `packages/manta-cli/tests/commands/inspect.test.ts`:
  - **Setup:** Create temp dir with `.manta/state/` structure, `createRuntime` with temp dir. Register a clone, write a contract, add some events. Use the same setup pattern as `status.test.ts`.
  - **Tests:**
    - `runInspectCommand` with valid cloneId -> exitCode 0, stdout contains clone_id, mode, state, contract task.
    - `runInspectCommand` with `json: true` -> stdout is valid JSON, parsed object has `clone`, `contract`, `locks`, `claims`, `recentEvents`, `liveness` keys.
    - `runInspectCommand` with non-existent cloneId -> throws `CliError` with `kind: 'not_found'`.
    - `runInspectCommand` with DEAD clone -> exitCode 0, stdout contains death_reason.
    - `runInspectCommand` with clone that has no contract -> stdout contains `(not yet written)`.
    - `runInspectCommand` with `eventCount: 3` -> at most 3 events in output.

**Acceptance:** `manta inspect` works end-to-end with in-memory bus. CLI wired. Tests green.

---

#### Task 1.5 — Tail: event formatter

**What:** Create the pure-function event formatter for the tail command.

**How:**

- [ ] Create `packages/manta-cli/src/output/tail-formatter.ts`:

  ```ts
  import type { BusEvent } from '@manta/bus';
  import { formatTimestamp, truncate } from './format.js';

  export function formatTailEvent(event: BusEvent): string { ... }
  export function formatTailEventRaw(event: BusEvent): string { ... }
  ```

  `formatTailEvent`:
  - Format: `[HH:mm:ss.SSS] <type padded to 16 chars>  <payload key=value pairs truncated at 80 chars>`
  - Event type left-padded to 16 chars for alignment.
  - Payload: extract top-level key-value pairs from `event.payload`, format as `key=value` (strings quoted, numbers bare, objects JSON-stringified and truncated).

  `formatTailEventRaw`:
  - Output raw JSON: `JSON.stringify(event)` — one JSON object per line for piping to `jq`.

- [ ] Create `packages/manta-cli/tests/output/tail-formatter.test.ts`:
  - Format heartbeat event -> timestamp + padded type + `state=WORKING`.
  - Format broadcast event -> payload truncated at 80 chars.
  - Format event with long payload -> truncated with `...`.
  - Raw format -> valid single-line JSON.
  - Type alignment -> all types produce same-width prefix.

**Acceptance:** Formatter produces readable one-line-per-event output. Tested with fixture events.

---

#### Task 1.6 — Tail: polling loop + command implementation + CLI wiring

**What:** Create the `manta tail <cloneId> [durationSeconds]` command with its own polling loop.

**How:**

- [ ] Create `packages/manta-cli/src/commands/tail.ts`:

  ```ts
  import type { Runtime } from '../runtime.js';
  import type { Reporter } from '../output/reporter.js';
  import type { CommandResult } from './status.js';
  import type { BusEvent } from '@manta/bus';
  import { CliError } from '../errors.js';
  import { sleep } from '../util/sleep.js';
  import { formatTailEvent, formatTailEventRaw } from '../output/tail-formatter.js';

  export interface RunTailOptions {
    cloneId: string;
    durationMs: number;
    intervalMs: number;
    raw: boolean;
    reporter: Reporter;
  }

  export async function runTailCommand(
    rt: Runtime,
    opts: RunTailOptions,
  ): Promise<CommandResult> { ... }
  ```

  Implementation:
  - Create `AbortController` — pass signal to `runTailLoop`.
  - Set up `SIGINT` handler to call `ctrl.abort()`.
  - `runTailLoop` returns accumulated output lines as `string[]`.
  - Return `{ exitCode: 0, stdout: lines.join('\n') }`.
  - If clone not found in registry after first 10s of polling, throw `CliError` with `kind: 'not_found'`.

- [ ] Implement `runTailLoop`:
  ```ts
  interface TailLoopOptions {
    rt: Runtime;
    cloneId: string;
    durationMs: number;
    intervalMs: number;
    raw: boolean;
    signal: AbortSignal;
    onLine: (line: string) => void;
  }

  async function runTailLoop(opts: TailLoopOptions): Promise<void> {
    let cursor = opts.rt.ctx.clock.now();
    const deadline = opts.rt.ctx.clock.now() + opts.durationMs;

    for (;;) {
      if (opts.signal.aborted) break;
      if (opts.rt.ctx.clock.now() >= deadline) break;

      const events = await opts.rt.ctx.events.readSince(cursor);
      const filtered = events.filter((e) => e.clone_id === opts.cloneId);

      for (const event of filtered) {
        const line = opts.raw
          ? formatTailEventRaw(event)
          : formatTailEvent(event);
        opts.onLine(line);
        cursor = Math.max(cursor, event.ts);
      }

      // Check if clone is DEAD
      try {
        const record = await opts.rt.ctx.registry.get(opts.cloneId);
        if (record.state === 'DEAD') {
          opts.onLine(`--- clone ${opts.cloneId} is DEAD: ${record.death_reason ?? 'unknown'} ---`);
          break;
        }
      } catch {
        // Clone not in registry yet — continue polling
      }

      await sleep(opts.intervalMs, opts.signal);
    }
  }
  ```

- [ ] Modify `packages/manta-cli/src/bin/manta.ts`:
  - Add import: `import { runTailCommand } from '../commands/tail.js';`
  - Add command registration after the `inspect` command:
    ```ts
    program
      .command('tail <cloneId> [durationSeconds]')
      .description('Stream events for a clone in real-time')
      .option('--interval <ms>', 'polling interval in milliseconds', '2000')
      .option('--raw', 'output raw JSON per line', false)
      .action(async (cloneId: string, durationSeconds: string | undefined, options: { interval: string; raw: boolean }) => {
        const durationMs = (durationSeconds != null ? parseInt(durationSeconds, 10) : 300) * 1000;
        const intervalMs = parseInt(options.interval, 10) || 2000;
        await runWithRuntime((rt) =>
          runTailCommand(rt, {
            cloneId,
            durationMs: Math.min(Math.max(durationMs, 10_000), 3_600_000),
            intervalMs: Math.min(Math.max(intervalMs, 500), 10_000),
            raw: options.raw,
            reporter,
          }),
        );
      });
    ```

- [ ] Create `packages/manta-cli/tests/commands/tail.test.ts`:
  - **Setup:** Create temp dir, `createRuntime`, register a clone. Use short intervals (100ms) and durations (1s-2s) for fast tests. Use `FakeClock` (from `@manta/bus`) to control time.
  - **Tests:**
    - Tail picks up events appended to EventsLog during the loop.
    - Tail exits when clone reaches DEAD state.
    - Tail exits when duration elapses.
    - Tail exits on signal abort (simulate Ctrl+C).
    - Tail with `raw: true` produces valid JSON lines.
    - Tail with non-existent clone that never registers -> `CliError` with `kind: 'not_found'` (after initial wait).
    - Tail only shows events for the specified cloneId (not sibling events).

**Acceptance:** `manta tail` works with polling loop. CLI wired. Tests green with fast intervals.

---

#### Task 1.7 — Build + workspace test sweep

**What:** Verify clean build and full workspace test pass.

**How:**

- [ ] Run `pnpm --filter @manta/cli build` — verify clean.
- [ ] Run `pnpm -r test` — verify all workspace tests green.
- [ ] Verify no lint warnings: `pnpm --filter @manta/cli lint` (or equivalent).

**Acceptance:** Clean build, all tests green, no lint warnings across workspace.

---

## Chunk 2: ForensicTimeline (bug #12) + replay + audit + FR e2e

**Goal of this chunk:** Every cast produces a forensic timeline JSONL (bug #12 fix). The operator can run `manta replay <castId>` for a cast-level forensic journal and `manta audit <cloneId>` for a single-clone action audit. A forking-realities e2e test validates the full lifecycle including merge-review.

**Files (new):**
- Create: `packages/manta-orchestrator/src/forensic-timeline.ts` — `ForensicTimeline` class (append, seal, read).
- Create: `packages/manta-orchestrator/src/replay.ts` — `reconstructTimeline`, `renderReplayMarkdown`, `renderReplayJson`.
- Create: `packages/manta-orchestrator/src/audit.ts` — `buildAuditLog`, `renderAuditMarkdown`, `renderAuditJson`.
- Create: `packages/manta-orchestrator/tests/forensic-timeline.test.ts`.
- Create: `packages/manta-orchestrator/tests/replay.test.ts`.
- Create: `packages/manta-orchestrator/tests/audit.test.ts`.
- Create: `packages/manta-orchestrator/tests/fixtures/event-factory.ts` — shared event sequence factory.
- Create: `packages/manta-cli/src/commands/replay.ts` — CLI command.
- Create: `packages/manta-cli/src/commands/audit.ts` — CLI command.
- Create: `packages/manta-cli/tests/commands/replay.test.ts`.
- Create: `packages/manta-cli/tests/commands/audit.test.ts`.
- Create: `packages/manta-e2e/tests/forking-realities.e2e.test.ts`.

**Files (modified):**
- Modify: `packages/manta-orchestrator/src/index.ts` — re-export new modules.
- Modify: `packages/manta-orchestrator/src/orchestrator.ts` — add `ForensicTimeline` append per cycle.
- Modify: `packages/manta-orchestrator/src/thresholds.ts` — add `timelinesDir` default.
- Modify: `packages/manta-cli/src/bin/manta.ts` — wire `replay` and `audit` commands.
- Modify: `packages/manta-cli/src/runtime.ts` — add `timelinesDir` path setup.
- Modify: `docs/manta-bugs.md` — update bug #12 status to Fixed.

### File size sanity check

`forensic-timeline.ts` projected ~100 LOC (JSONL append + seal + read). `replay.ts` projected ~180 LOC (timeline reconstruction + markdown renderer + JSON renderer). `audit.ts` projected ~160 LOC (audit log assembly + gap analysis + markdown renderer + JSON renderer). `event-factory.ts` projected ~80 LOC (realistic event sequence builder). CLI commands ~60-80 LOC each (thin argv + delegation). FR e2e ~200 LOC (follows recon-swarm pattern). Test files ~120-180 LOC each. None crosses unwieldy.

### Tasks

#### Task 2.1 — ForensicTimeline extraction (bug #12 fix)

**What:** Create `packages/manta-orchestrator/src/forensic-timeline.ts` — a production-grade timeline recorder that captures per-cycle clone state snapshots as JSONL.

**Why:** Bug #12: forensic timeline JSON is produced only by the e2e test harness (`recon-swarm.e2e.test.ts` lines 84-97). Production casts produce no equivalent. This extracts the concept into `@manta/orchestrator` so every cast emits a timeline file.

**How:**

- [ ] Define types:
  ```ts
  import type { CloneState } from '@manta/bus';

  export interface TimelineSnapshot {
    ts: number;
    cycleNumber: number;
    clones: Array<{
      clone_id: string;
      state: CloneState;
      last_heartbeat_at: number;
      progress?: string;
      death_reason?: string;
      died_at?: number;
    }>;
  }

  export interface ForensicTimeline {
    cast_id: string;
    mode: string;
    started_at: number;
    finished_at: number | null;
    duration_ms: number | null;
    sealed: boolean;
    snapshots: TimelineSnapshot[];
  }
  ```

- [ ] Implement `ForensicTimelineWriter` class:
  ```ts
  export class ForensicTimelineWriter {
    private cycleNumber = 0;

    constructor(
      private readonly filePath: string,
      private readonly meta: { cast_id: string; mode: string; started_at: number },
    ) {}

    async appendSnapshot(snapshot: Omit<TimelineSnapshot, 'cycleNumber'>): Promise<void> {
      // Append a JSONL line: { ...snapshot, cycleNumber: this.cycleNumber++ }
      // Uses appendJsonLine from @manta/bus (or inline fs.appendFile for isolation)
    }

    async seal(finishedAt: number): Promise<void> {
      // Append a seal line: { sealed: true, finished_at, duration_ms }
    }
  }
  ```

- [ ] Implement `readForensicTimeline(filePath: string): Promise<ForensicTimeline | null>`:
  - Read JSONL file, parse each line.
  - Reconstruct `ForensicTimeline` from snapshot lines + seal line.
  - Return `null` if file does not exist.
  - Tolerate truncated last line (same crash-safety as `EventsLog.readAll`).

- [ ] Add `timelinesDir` to Thresholds:
  - Modify `packages/manta-orchestrator/src/thresholds.ts`: add `timelinesDir: z.string().min(1)` to `ThresholdsSchema`.
  - Add `timelinesDir: '.manta/state/timelines'` to the `defaultThresholds` constant (the schema uses `.strict()` with no Zod `.default()` — all defaults live in `defaultThresholds`).
  - Update existing tests that construct `Thresholds` manually (`packages/manta-orchestrator/tests/thresholds.test.ts`, orchestrator test helpers) to include `timelinesDir` — strict schema will reject objects missing the new field.

- [ ] Create `packages/manta-orchestrator/tests/forensic-timeline.test.ts`:
  - `appendSnapshot` writes JSONL line with correct schema.
  - Sequential appends produce ordered lines with incrementing `cycleNumber`.
  - `seal` sets `finished_at` and appends seal marker.
  - `readForensicTimeline` parses JSONL into `ForensicTimeline`.
  - `readForensicTimeline` returns `null` for missing file.
  - `readForensicTimeline` tolerates truncated last line.

**Acceptance:** `ForensicTimeline` reader/writer fully tested. Bug #12's core infrastructure in place.

---

#### Task 2.2 — Wire ForensicTimeline into orchestrator

**What:** Modify `Orchestrator` to accept an optional `ForensicTimelineWriter` and append a snapshot after every `runCycle`.

**How:**

- [ ] Modify `packages/manta-orchestrator/src/orchestrator.ts`:

  Add optional `timeline` to `OrchestratorOptions`:
  ```ts
  export interface OrchestratorOptions {
    ctx: BusContext;
    thresholds: Thresholds;
    probe: PidProbe;
    writer: PostMortemWriter;
    timeline?: ForensicTimelineWriter;  // NEW — optional, absent for non-cast orchestrators
  }
  ```

  At the end of `runCycle()`, after post-mortems, if `this.opts.timeline` is present:
  ```ts
  if (this.opts.timeline) {
    const allClones = await this.opts.ctx.registry.list();
    await this.opts.timeline.appendSnapshot({
      ts: ranAt,
      clones: allClones.map((c) => ({
        clone_id: c.clone_id,
        state: c.state,
        last_heartbeat_at: c.last_heartbeat_at,
        progress: c.progress,
        death_reason: c.death_reason,
        died_at: c.died_at,
      })),
    });
  }
  ```

  **Note:** The `timeline` field is optional. Existing callers that construct `Orchestrator` without it (e.g. `recover` command, tests) are unaffected. Only `cast.ts` passes a timeline writer — wired in Task 2.3.

- [ ] Update existing orchestrator tests to verify backward compatibility: construct `Orchestrator` without `timeline`, run cycle, no error.

**Acceptance:** Orchestrator appends timeline snapshots when a writer is provided. No behavioral change for existing callers.

---

#### Task 2.3 — Wire ForensicTimeline into cast command + seal on completion

**What:** Modify `packages/manta-cli/src/commands/cast.ts` to create a `ForensicTimelineWriter` and pass it to the orchestrator. Seal the timeline after the tick loop exits.

**How:**

- [ ] Modify `packages/manta-cli/src/runtime.ts`:
  - Add `timelinesDir` path to the mkdir calls in `createRuntime`:
    ```ts
    await fs.mkdir(path.join(repoRoot, thresholds.timelinesDir), { recursive: true });
    ```

- [ ] Modify `packages/manta-cli/src/commands/cast.ts`:
  - Add imports at top of file:
    ```ts
    import { Orchestrator, makeProbe, fsPostMortemWriter, ForensicTimelineWriter } from '@manta/orchestrator';
    import { join } from 'node:path';
    ```
  - After creating worktrees (line 80 area), before the tick loop, create a `ForensicTimelineWriter`:
    ```ts

    const timelinePath = join(rt.repoRoot, rt.thresholds.timelinesDir, `${opts.castId}.jsonl`);
    const timeline = new ForensicTimelineWriter(timelinePath, {
      cast_id: opts.castId,
      mode: opts.mode,
      started_at: Date.now(),
    });
    ```
  - **Challenge:** The `Orchestrator` is constructed in `createRuntime`, not in `cast.ts`. The timeline writer is per-cast, not per-runtime. Two options:
    - (a) Create a new `Orchestrator` inside `cast.ts` with the timeline writer, shadowing `rt.orchestrator`. Clean per-cast isolation but duplicates construction.
    - (b) Add a `setTimeline(writer)` method to `Orchestrator`. Simpler wiring but mutable state.
    - **Decision:** (a) — construct a cast-local `Orchestrator` with the timeline writer. The runtime's orchestrator is for non-cast commands (status, recover). Cast commands need per-cast configuration. This matches the pattern where `cast.ts` already creates cast-specific resources (worktrees, policies, handles).

    ```ts
    const castOrchestrator = new Orchestrator({
      ctx: rt.ctx,
      thresholds: rt.thresholds,
      probe: makeProbe(),
      writer: fsPostMortemWriter({ repoRoot: rt.repoRoot, postMortemDir: rt.thresholds.postMortemDir }),
      timeline,
    });
    ```
    Replace `rt.orchestrator` with `castOrchestrator` in the `runTickLoop` call.

  - After the tick loop exits (regardless of abort/completion), seal the timeline:
    ```ts
    await timeline.seal(Date.now());
    ```
    Place this in the `finally` block or after the abort/reap logic, before the merge-review trigger.

- [ ] Existing tests in `cast.test.ts` must remain green — they use a Runtime whose `orchestrator` has no timeline writer, and `cast.ts` will construct its own cast-local orchestrator.

**Acceptance:** Every `manta cast` produces `.manta/state/timelines/<castId>.jsonl`. Sealed after completion.

---

#### Task 2.4 — Event fixture factory

**What:** Create a shared event sequence factory for replay and audit tests.

**How:**

- [ ] Create `packages/manta-orchestrator/tests/fixtures/event-factory.ts`:

  ```ts
  import type { BusEvent } from '@manta/bus';

  export interface CastEventSequenceOptions {
    castId: string;
    cloneIds: string[];
    startTs: number;
    includeReview?: boolean;    // default true
    includePromote?: boolean;   // default false
  }

  export function createCastEventSequence(opts: CastEventSequenceOptions): BusEvent[] {
    // Returns a realistic sequence:
    // - contract_write x N (one per clone, ts offset +0s, +0.1s, ...)
    // - register x N (+2s, +3s, ...)
    // - heartbeat x N (state=WORKING, +6s, +7s, ...)
    // - contract_ack x N (+6.1s, +7.1s, ...)
    // - lock x1 (clone A, +15s)
    // - broadcast x1 (clone B, +45s)
    // - zk_write x1 (clone A, +78s)
    // - unlock x1 (clone A, +80s)
    // - suicide_intent x N (+120s, +125s, ...)
    // - death x N (+121s, +126s, ...)
    // - post_mortem x N (+121.5s, +126.5s, ...)
    // - merge_review (if includeReview, +180s)
    // - promote (if includePromote, +200s)
    //
    // Each event has a unique `id` and monotonic `ts`.
  }
  ```

  Helper: `makeEvent(overrides: Partial<BusEvent> & Pick<BusEvent, 'type' | 'ts'>): BusEvent` — fills in defaults for `id`, `clone_id`, `payload`.

- [ ] No separate test file for the factory — it's tested implicitly by replay and audit tests.

**Acceptance:** Factory produces realistic event sequences for testing. Reused by replay and audit test files.

---

#### Task 2.5 — Replay: data assembly in orchestrator

**What:** Create `packages/manta-orchestrator/src/replay.ts` — timeline reconstruction logic.

**How:**

- [ ] Define `ReplayTimeline`:
  ```ts
  import type { BusEvent, CastManifest, CloneRecord } from '@manta/bus';

  export type ReplayPhase = 'spawn' | 'working' | 'death' | 'review';

  export interface ReplayEvent {
    phase: ReplayPhase;
    event: BusEvent;
    offsetMs: number;  // offset from cast created_at
  }

  export interface ReplayCloneSummary {
    clone_id: string;
    registeredOffsetMs: number | null;
    firstHeartbeatOffsetMs: number | null;
    diedOffsetMs: number | null;
    lifespanMs: number | null;
    deathReason: string | null;
  }

  export interface ReplayTimeline {
    castId: string;
    mode: string;
    cloneIds: string[];
    createdAt: number;
    events: ReplayEvent[];
    cloneSummaries: ReplayCloneSummary[];
    mergeReviewVerdict: string | null;
    postMortemPaths: string[];
  }
  ```

- [ ] Implement `reconstructTimeline`:
  ```ts
  export interface ReconstructTimelineOptions {
    cloneFilter?: string[];  // show only these clones
    since?: number;           // epoch ms — events after this time
  }

  export interface ReplayBusContext {
    casts: { read(castId: string): Promise<CastManifest> };
    registry: { get(cloneId: string): Promise<CloneRecord> };
    events: { readAll(): Promise<BusEvent[]> };
  }

  export async function reconstructTimeline(
    ctx: ReplayBusContext,
    castId: string,
    opts?: ReconstructTimelineOptions,
  ): Promise<ReplayTimeline> { ... }
  ```

  Algorithm:
  1. Read `CastManifest` for `castId` -> extract roster.
  2. Apply `cloneFilter` if provided (subset of roster).
  3. Read `EventsLog.readAll()`.
  4. Filter events: `clone_id` in roster OR `payload.cast_id === castId` (cast-level events).
  5. Apply `since` filter if provided.
  6. Preserve file order (do NOT re-sort by ts — per EventsLog ordering contract).
  7. Classify each event into a `ReplayPhase`:
     - `contract_write`, `register` -> `spawn`
     - `heartbeat`, `contract_ack`, `lock`, `unlock`, `renew_lock`, `claim`, `release`, `broadcast`, `message`, `drift_report`, `zk_write`, `para_append` -> `working`
     - `suicide_intent`, `death`, `post_mortem`, `lock_reap`, `claim_reap` -> `death`
     - `merge_review`, `promote` -> `review`
  8. Compute per-clone summaries from registry records.
  9. Extract merge-review verdict from events (if present).
  10. Extract post-mortem paths from `post_mortem` events.

- [ ] Implement `renderReplayMarkdown(timeline: ReplayTimeline): string`:
  - Header: `# Replay — <castId>`, mode, clones, created_at.
  - Per-phase table: `| Time | Clone | Event | Detail |`.
  - Time shown as offset from `createdAt` using `formatOffsetSeconds`.
  - Detail: truncated payload (80 chars).
  - Summary table: per-clone registered/died/lifespan/death_reason.
  - Post-mortem and merge-review cross-references.

- [ ] Implement `renderReplayJson(timeline: ReplayTimeline): object`:
  - Returns the `ReplayTimeline` object directly (JSON-serializable).

- [ ] Create `packages/manta-orchestrator/tests/replay.test.ts`:
  - Uses `createCastEventSequence` fixture factory.
  - `reconstructTimeline` filters events by roster clone_ids only.
  - `reconstructTimeline` includes cast-level events (merge_review, promote).
  - `reconstructTimeline` preserves file order (does NOT re-sort by ts).
  - `reconstructTimeline` with clone filter -> only specified clones in output.
  - `reconstructTimeline` with since filter -> events after timestamp only.
  - `reconstructTimeline` handles missing clone in registry gracefully (catch `BusNotFoundError`, summary shows null for that clone).
  - `renderReplayMarkdown` contains header with mode and clones.
  - `renderReplayMarkdown` groups events by phase.
  - `renderReplayMarkdown` summary table has per-clone lifespan.
  - `renderReplayJson` returns object with correct shape.
  - Cast not found -> throws (propagates `BusNotFoundError` from `casts.read`).

**Acceptance:** Replay data assembly fully tested with in-memory bus fixtures. No filesystem dependency.

---

#### Task 2.6 — Audit: data assembly in orchestrator

**What:** Create `packages/manta-orchestrator/src/audit.ts` — audit log assembly with gap analysis.

**How:**

- [ ] Define types:
  ```ts
  import type { BusEvent, CloneRecord } from '@manta/bus';

  export interface AuditEntry {
    event: BusEvent;
    offsetMs: number;           // offset from clone registered_at
    gapFromPreviousMs: number;  // time since previous event (0 for first)
  }

  export interface GapAnomaly {
    fromEvent: BusEvent;
    toEvent: BusEvent;
    gapMs: number;
    offsetMs: number;
  }

  export interface AuditLog {
    cloneId: string;
    castId: string | null;   // from registry metadata, null if absent
    mode: string;
    registeredAt: number;
    diedAt: number | null;
    deathReason: string | null;
    entries: AuditEntry[];
    gapAnomalies: GapAnomaly[];
    stats: {
      totalEvents: number;
      lifespanMs: number | null;
      avgGapMs: number | null;
      maxGapMs: number | null;
    };
  }
  ```

- [ ] Define event type groups (convenience aliases for `--type` filter):
  ```ts
  export const EVENT_TYPE_GROUPS: Record<string, string[]> = {
    lifecycle: ['register', 'heartbeat', 'suicide_intent', 'death'],
    contract: ['contract_write', 'contract_ack', 'contract_refresh'],
    resources: ['lock', 'unlock', 'renew_lock', 'claim', 'release'],
    communication: ['broadcast', 'message', 'drift_report'],
    knowledge: ['zk_write', 'para_append'],
    orchestrator: ['post_mortem', 'lock_reap', 'claim_reap'],
  };
  ```

- [ ] Implement `buildAuditLog`:
  ```ts
  export interface BuildAuditLogOptions {
    typeFilter?: string[];       // event types or group names
    since?: number;              // epoch ms
    limit?: number;              // max events to show (tail, not head)
    gapThresholdMs?: number;     // default 30_000 (30s)
  }

  export interface AuditBusContext {
    registry: { get(cloneId: string): Promise<CloneRecord> };
    events: { readAll(): Promise<BusEvent[]> };
  }

  export async function buildAuditLog(
    ctx: AuditBusContext,
    cloneId: string,
    opts?: BuildAuditLogOptions,
  ): Promise<AuditLog> { ... }
  ```

  Algorithm:
  1. Read `CloneRecord` via `ctx.registry.get(cloneId)` — throws `BusNotFoundError` if not found.
  2. Extract `castId` from `record.metadata.cast_id` (may be undefined -> null).
  3. Read `EventsLog.readAll()`, filter by `event.clone_id === cloneId`.
  4. Expand type filter groups: if filter contains a group name (e.g. `'lifecycle'`), replace with constituent types.
  5. Apply type filter if provided.
  6. Apply `since` filter if provided.
  7. Apply `limit` if provided — take last N events (tail, not head).
  8. Compute per-entry `offsetMs` from `record.registered_at`.
  9. Compute per-entry `gapFromPreviousMs` (0 for first entry).
  10. Identify gap anomalies: entries where `gapFromPreviousMs > gapThresholdMs`.
  11. Compute stats: total events, lifespan (died_at - registered_at, null if alive), avg gap, max gap.

- [ ] Implement `renderAuditMarkdown(log: AuditLog): string`:
  - Header: `# Audit — clone <id> (cast-<id>)`, mode, registered, died.
  - Event table: `| Offset | Type | Detail | gap prev |`.
  - Offset shown using `formatOffsetSeconds`.
  - Detail: truncated payload key=value pairs (80 chars).
  - Gap analysis section (if `gapAnomalies.length > 0`): list each gap with from/to timestamps and duration.
  - Summary stats line: total events, lifespan, avg gap, max gap.

- [ ] Implement `renderAuditJson(log: AuditLog): object`:
  - Returns the `AuditLog` object directly.

- [ ] Create `packages/manta-orchestrator/tests/audit.test.ts`:
  - Uses `createCastEventSequence` fixture factory (filtered to one clone).
  - `buildAuditLog` filters events by exact clone_id match.
  - `buildAuditLog` calculates relative offsets from registered_at.
  - `buildAuditLog` calculates inter-event gaps.
  - Type filter restricts to specified event types.
  - Type group filter (`lifecycle`) expands to constituent types.
  - `since` filter works on absolute timestamp.
  - `limit` returns last N events (tail, not head).
  - Clone not found -> throws `BusNotFoundError`.
  - Gap analysis highlights gaps > threshold (default 30s).
  - Stats: total events, lifespan, avg gap, max gap computed correctly.
  - `renderAuditMarkdown` contains header with clone metadata.
  - `renderAuditMarkdown` gap analysis section present when anomalies exist.
  - `renderAuditJson` returns object with correct shape.
  - Empty event list renders cleanly (no divide-by-zero on avg gap).

**Acceptance:** Audit log assembly fully tested. Gap analysis correct. Type groups expand properly.

---

#### Task 2.7 — Replay: CLI command

**What:** Create `packages/manta-cli/src/commands/replay.ts` and wire into `bin/manta.ts`.

**How:**

- [ ] Create `packages/manta-cli/src/commands/replay.ts`:
  ```ts
  import type { Runtime } from '../runtime.js';
  import type { Reporter } from '../output/reporter.js';
  import type { CommandResult } from './status.js';
  import { CliError } from '../errors.js';
  import { reconstructTimeline, renderReplayMarkdown, renderReplayJson } from '@manta/orchestrator';

  export interface RunReplayOptions {
    castId: string;
    format: 'markdown' | 'json';
    cloneFilter?: string[];
    since?: number;
    reporter: Reporter;
  }

  export async function runReplayCommand(
    rt: Runtime,
    opts: RunReplayOptions,
  ): Promise<CommandResult> {
    try {
      const timeline = await reconstructTimeline(rt.ctx, opts.castId, {
        cloneFilter: opts.cloneFilter,
        since: opts.since,
      });
      const stdout = opts.format === 'json'
        ? JSON.stringify(renderReplayJson(timeline), null, 2)
        : renderReplayMarkdown(timeline);
      return { exitCode: 0, stdout };
    } catch (err) {
      if (err && typeof err === 'object' && 'name' in err && (err as Error).name === 'BusNotFoundError') {
        throw new CliError(`cast not found: ${opts.castId}`, { kind: 'not_found', cause: err });
      }
      throw err;
    }
  }
  ```

- [ ] Wire into `packages/manta-cli/src/bin/manta.ts`:
  ```ts
  program
    .command('replay <castId>')
    .description('Forensic timeline replay for a completed cast')
    .option('--format <fmt>', 'output format (markdown or json)', 'markdown')
    .option('--clone <id>', 'filter to specific clone (repeatable)', (val, prev: string[]) => [...prev, val], [] as string[])
    .option('--since <ts>', 'show events after this epoch ms timestamp')
    .action(async (castId: string, options: { format: string; clone: string[]; since?: string }) => {
      await runWithRuntime((rt) =>
        runReplayCommand(rt, {
          castId,
          format: options.format === 'json' ? 'json' : 'markdown',
          cloneFilter: options.clone.length > 0 ? options.clone : undefined,
          since: options.since != null ? parseInt(options.since, 10) : undefined,
          reporter,
        }),
      );
    });
  ```

- [ ] Create `packages/manta-cli/tests/commands/replay.test.ts`:
  - Setup: temp dir, write cast manifest JSON to `.manta/state/casts/<castId>.json`, populate events.jsonl, write registry records.
  - `runReplayCommand` -> exitCode 0, stdout contains `# Replay —`.
  - `--format json` -> valid JSON output.
  - `--clone A` -> only clone A events in output.
  - Non-existent castId -> `CliError` with `kind: 'not_found'`.

**Acceptance:** `manta replay` wired and tested. Delegates to orchestrator for data assembly.

---

#### Task 2.8 — Audit: CLI command

**What:** Create `packages/manta-cli/src/commands/audit.ts` and wire into `bin/manta.ts`.

**How:**

- [ ] Create `packages/manta-cli/src/commands/audit.ts`:
  ```ts
  import type { Runtime } from '../runtime.js';
  import type { Reporter } from '../output/reporter.js';
  import type { CommandResult } from './status.js';
  import { CliError } from '../errors.js';
  import { buildAuditLog, renderAuditMarkdown, renderAuditJson } from '@manta/orchestrator';

  export interface RunAuditOptions {
    cloneId: string;
    format: 'markdown' | 'json';
    typeFilter?: string[];
    since?: number;
    limit?: number;
    showGaps: boolean;
    gapThresholdMs: number;
    reporter: Reporter;
  }

  export async function runAuditCommand(
    rt: Runtime,
    opts: RunAuditOptions,
  ): Promise<CommandResult> {
    try {
      const log = await buildAuditLog(rt.ctx, opts.cloneId, {
        typeFilter: opts.typeFilter,
        since: opts.since,
        limit: opts.limit,
        gapThresholdMs: opts.gapThresholdMs,
      });
      let stdout: string;
      if (opts.format === 'json') {
        stdout = JSON.stringify(renderAuditJson(log), null, 2);
      } else {
        stdout = renderAuditMarkdown(log);
      }
      return { exitCode: 0, stdout };
    } catch (err) {
      if (err && typeof err === 'object' && 'name' in err && (err as Error).name === 'BusNotFoundError') {
        throw new CliError(`clone not found: ${opts.cloneId}`, { kind: 'not_found', cause: err });
      }
      throw err;
    }
  }
  ```

- [ ] Wire into `packages/manta-cli/src/bin/manta.ts`:
  ```ts
  program
    .command('audit <cloneId>')
    .description('Action audit log for a single clone with gap analysis')
    .option('--format <fmt>', 'output format (markdown or json)', 'markdown')
    .option('--type <types>', 'comma-separated event types or group names')
    .option('--since <ts>', 'show events after this epoch ms timestamp')
    .option('--limit <n>', 'max events to show')
    .option('--gaps', 'highlight inter-event gaps', false)
    .option('--gap-threshold <ms>', 'gap threshold in milliseconds', '30000')
    .action(async (cloneId: string, options: { format: string; type?: string; since?: string; limit?: string; gaps: boolean; gapThreshold: string }) => {
      const typeFilter = options.type?.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
      await runWithRuntime((rt) =>
        runAuditCommand(rt, {
          cloneId,
          format: options.format === 'json' ? 'json' : 'markdown',
          typeFilter,
          since: options.since != null ? parseInt(options.since, 10) : undefined,
          limit: options.limit != null ? parseInt(options.limit, 10) : undefined,
          showGaps: options.gaps,
          gapThresholdMs: parseInt(options.gapThreshold, 10) || 30_000,
          reporter,
        }),
      );
    });
  ```

- [ ] Create `packages/manta-cli/tests/commands/audit.test.ts`:
  - Setup: temp dir, register clone, populate events.
  - `runAuditCommand` -> exitCode 0, stdout contains `# Audit —`.
  - `--format json` -> valid JSON output.
  - `--type heartbeat` -> only heartbeat events in output.
  - `--type lifecycle` -> expands to register, heartbeat, suicide_intent, death.
  - `--limit 5` -> at most 5 events in output.
  - `--gaps` -> gap analysis section present in output.
  - Non-existent cloneId -> `CliError` with `kind: 'not_found'`.

**Acceptance:** `manta audit` wired and tested. Type groups expand correctly. Gap analysis works.

---

#### Task 2.9 — Orchestrator index re-exports

**What:** Re-export new modules from `packages/manta-orchestrator/src/index.ts`.

**How:**

- [ ] Add to `packages/manta-orchestrator/src/index.ts`:
  ```ts
  export * from './forensic-timeline';
  export * from './replay';
  export * from './audit';
  ```

- [ ] Run `pnpm --filter @manta/orchestrator build` — verify clean.

**Acceptance:** All new types and functions exported from `@manta/orchestrator`.

---

#### Task 2.10 — Forking-realities e2e test

**What:** Create an end-to-end test proving the forking-realities cast mode works with real `claude --print` clones.

**Why:** Validates the full FR lifecycle: distinct assignments, merge-review scoring, forensic timeline, post-mortems, ZK notes. Analogous to `recon-swarm.e2e.test.ts` but covering FR-specific mechanics.

**How:**

- [ ] Enhance sample repo fixture (`packages/manta-e2e/tests/fixtures/sample-repo/src/auth.ts`) — ensure it contains extractable inline validation logic:
  ```ts
  export function authenticate(user: string, pass: string): boolean {
    if (!user || user.length < 3) return false;
    if (!pass || pass.length < 8) return false;
    if (user === 'admin' && pass === 'admin123') return true;
    return false;
  }
  ```
  If the existing `auth.ts` already has this or similar extractable logic, no change needed. If it's a stub, add the above.

- [ ] Create `packages/manta-e2e/tests/forking-realities.e2e.test.ts`:

  ```ts
  import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
  import * as fs from 'node:fs/promises';
  import * as path from 'node:path';
  import { fileURLToPath } from 'node:url';
  import { execa } from 'execa';
  import { probeClaudeBin } from './helpers/claudeBin.js';
  import { makeSampleRepo, type SampleRepoFixture } from './helpers/sampleRepo.js';

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const cliBin = path.join(repoRoot, 'packages/manta-cli/dist/bin/manta.cjs');

  describe('forking-realities end-to-end against real claude', () => {
    let fx: SampleRepoFixture | undefined;
    let claude: Awaited<ReturnType<typeof probeClaudeBin>>;
    let suiteFailed = false;

    beforeAll(async () => {
      claude = await probeClaudeBin();
    });

    afterEach((ctx) => {
      if (ctx.task.result?.state === 'fail') suiteFailed = true;
    });

    afterAll(async () => {
      if (!fx) return;
      const force = process.env.MANTA_E2E_KEEP === '1';
      if (suiteFailed || force) {
        console.warn(
          `[forking-realities.e2e] preserving evidence at ${fx.root}`,
        );
        return;
      }
      await fx.cleanup();
    });

    it('runs a 2-clone forking-realities cast, scores, and produces merge-review', async () => {
      if (!claude.available) {
        console.warn(`[forking-realities.e2e] SKIPPED: ${claude.reason}`);
        return;
      }
      fx = await makeSampleRepo();

      const expectedCloneCount = 2;
      const tickBudgetMs = 1_500_000;

      const castProc = execa(
        'node',
        [
          cliBin, 'cast', 'forking-realities',
          '--clones', String(expectedCloneCount),
          '--task', 'Refactor src/auth.ts to extract the validation logic into a separate function.',
          '--tasks', ... , // or --assignments if supported
          '--cycle-interval-ms', '5000',
          '--tick-budget-ms', String(tickBudgetMs),
          '--budget-per-clone-usd', '5',
          '--max-files-changed', '5',
          '--allowed-paths', 'src,docs',
        ],
        { cwd: fx.root, reject: false, timeout: 28 * 60 * 1000 },
      );

      const result = await castProc;
      // ... assertions below
    }, 28 * 60 * 1000);
  });
  ```

  **Assertions:**
  1. Cast process exits 0.
  2. Registry: exactly 2 clones, both DEAD.
  3. Each clone has at least 1 commit in its worktree branch.
  4. Events log contains a `merge_review` event with correct `cast_id`.
  5. Merge-review markdown exists at `docs/merge-reviews/<castId>.md`.
  6. Verdict is one of: `auto_merge_eligible`, `manual_review_required`.
  7. Scores array has length 2.
  8. Post-mortems: >= 2 markdown files.
  9. ZK notes: >= 2.
  10. Forensic timeline JSONL exists at `.manta/state/timelines/<castId>.jsonl` (bug #12 validation).
  11. Each clone's contract has a distinct `assignment` field (approach differentiation).

  **Gating:** `MANTA_E2E=1` environment variable. Skip with `console.warn` if `probeClaudeBin()` reports unavailable.

  **Note on --tasks/--assignments:** The `cast.ts` already supports `--tasks <path>` for a YAML file with per-clone task overlays. The e2e test should create a temp tasks file with two entries:
  ```yaml
  A:
    approach_hint: "Extract as a pure function validateCredentials(user, pass) returning boolean"
  B:
    approach_hint: "Extract as a class CredentialValidator with a validate method"
  ```
  Write this file to the temp repo before invoking the cast.

**Acceptance:** FR e2e test validates full lifecycle. Gated by `MANTA_E2E=1`. Follows the same evidence-preservation pattern as recon-swarm e2e.

---

#### Task 2.11 — Bug #12 status update + docs

**What:** Update bug #12 status in `docs/manta-bugs.md`. Move it from "Open bugs" to "Fixed bugs" or update status inline.

**How:**

- [ ] Update `docs/manta-bugs.md` bug #12:
  - Status: `**Fixed in this commit** — ForensicTimeline extracted from e2e harness to @manta/orchestrator. Production casts now emit .manta/state/timelines/<castId>.jsonl.`
  - Reference the Phase 2d commit.

- [ ] Run full workspace test sweep: `pnpm -r test`.
- [ ] Verify clean build: `pnpm --filter @manta/orchestrator build && pnpm --filter @manta/cli build`.

**Acceptance:** Bug #12 marked fixed. All tests green. Clean build.

---

## Cross-cutting concerns

### Test coverage targets

| Package | File | Target |
|---------|------|--------|
| `@manta/cli` | `util/sleep.ts` | >= 90% (simple utility, easy to cover) |
| `@manta/cli` | `output/format.ts` | >= 95% (pure functions, exhaustive) |
| `@manta/cli` | `output/inspect-renderer.ts` | >= 85% |
| `@manta/cli` | `output/tail-formatter.ts` | >= 90% |
| `@manta/cli` | `commands/inspect.ts` | >= 80% |
| `@manta/cli` | `commands/tail.ts` | >= 80% |
| `@manta/cli` | `commands/replay.ts` | >= 80% |
| `@manta/cli` | `commands/audit.ts` | >= 80% |
| `@manta/orchestrator` | `forensic-timeline.ts` | >= 85% |
| `@manta/orchestrator` | `replay.ts` | >= 85% |
| `@manta/orchestrator` | `audit.ts` | >= 85% |

### Docs updates

- `CHANGELOG.md`: Phase 2d entry listing all four commands + bug #12 fix.
- `docs/manta-bugs.md`: bug #12 status update.
- No new user-facing docs for individual commands in Phase 2d — the commands are self-documenting via `--help`. User-facing observability guide deferred to Phase 3+ when all tiers are battle-tested via dogfood.

### Risk hedges

1. **`readAll()` performance for tail.** Current `EventsLog.readSince` calls `readAll()` then filters. For typical Phase 2 casts (~500 events, ~50KB), this is sub-millisecond. Phase 3+ daemon-mode may need cursor/offset optimization. For Phase 2d: no optimization needed.

2. **Tail test timing sensitivity.** Tail tests use short intervals (100ms) and durations (1-2s). FakeClock from `@manta/bus` controls time advancement, avoiding flaky wall-clock-dependent assertions. If tests flake despite FakeClock, add `test.sequential` annotation.

3. **FR e2e model cost.** The FR e2e runs real `claude --print` clones with haiku-class models. Each clone costs ~$0.50-1.00 per run. The test is gated by `MANTA_E2E=1` to avoid accidental CI cost. Same gating pattern as recon-swarm e2e.

4. **ForensicTimeline adds a `registry.list()` call per orchestrator cycle.** This is a JSON file read (<1ms for Phase 2 clone counts). The timeline writer is optional — non-cast orchestrator callers (recover, status) don't pay the cost. Phase 3+ daemon-mode can switch to delta-based snapshots if the full registry read becomes a bottleneck.

5. **Cast-local orchestrator construction.** Task 2.3 constructs a new `Orchestrator` inside `cast.ts` rather than reusing `rt.orchestrator`. This is intentional: cast commands need per-cast configuration (timeline writer, potentially per-cast thresholds in Phase 3+). The runtime's orchestrator remains available for non-cast commands.
