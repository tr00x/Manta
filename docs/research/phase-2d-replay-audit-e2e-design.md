# Phase 2d — `/manta replay`, `/manta audit`, and Forking-Realities E2E Design

**Author:** Clone C (recon-swarm, cast-1779812169241)
**Date:** 2026-05-26
**Status:** Research deliverable — pending main review

---

## `/manta replay <castId>` Design

### Purpose

Tier 4 forensic command (spec §11.0). Post-cast journal viewer: reconstructs the
full chronological timeline of a cast across all participating clones. "Разбор
после fact'а" — the operator reads replay *after* a cast completes, not during.

### Data Sources

Replay aggregates four orthogonal data stores. All are already on disk after a cast
completes; replay is a pure read-only renderer.

| # | Source | API | Data extracted |
|---|--------|-----|----------------|
| 1 | **Cast manifest** | `CastsStore.read(castId)` → `CastManifest` | `mode`, `clones[].clone_id`, `clones[].assignment`, `policy`, `created_at` |
| 2 | **Events log** | `EventsLog.readAll()` filtered by roster clone_ids + cast-level events | Every `BusEvent` where `clone_id ∈ roster` OR `payload.cast_id === castId` |
| 3 | **Registry records** | `Registry.get(cloneId)` for each roster member | `registered_at`, `last_heartbeat_at`, `died_at`, `death_reason`, `state`, `worktree`, `metadata`, `progress` |
| 4 | **Merge-review event** | Filter events for `type === 'merge_review' && payload.cast_id === castId` | `verdict`, `scores[]`, `winner_clone_id`, `tie_break_method` |
| 5 | **Post-mortem files** | Filter events for `type === 'post_mortem' && clone_id ∈ roster` → `payload.path` | Per-clone post-mortem markdown paths (for cross-reference, not inline) |

**Not a data source (by design):** ZK notes and PARA entries. These are knowledge
artifacts, not audit data. Replay stays in the "what happened" lane; ZK notes are
"what was learned." Cross-referencing is the human's job.

### Timeline Reconstruction Algorithm

```
1. Read CastManifest for castId → extract roster = manifest.clones.map(c => c.clone_id)
2. Read EventsLog.readAll()
3. Filter events:
   - clone_id ∈ roster (clone-scoped events)
   - OR payload.cast_id === castId (cast-level events: merge_review, promote)
   - OR type === 'contract_write' && payload.clone_id ∈ roster (contracts written by spawner)
4. Sort by append-order (file order per EventsLog ordering contract — do NOT re-sort by ts)
5. For each roster clone, read Registry.get(cloneId) for terminal state metadata
6. Group events into lifecycle phases per clone:
   Phase 1: SPAWN    — contract_write → register
   Phase 2: WORKING  — register → suicide_intent (heartbeats, locks, claims, broadcasts, ZK writes)
   Phase 3: DEATH    — suicide_intent → death (+ post_mortem)
   Phase 4: REVIEW   — merge_review, promote (cast-level, after all clones dead)
7. Render output
```

### Output Format

Markdown timeline rendered to stdout. Sections follow cast lifecycle phases, not
per-clone silos (interleaved chronological view is more useful for forensics).

```markdown
# Replay — cast-1779812169241

**Mode:** recon-swarm | **Clones:** A, B, C | **Created:** 2026-05-26T16:16:13Z

## Phase: Spawn
| Time | Clone | Event | Detail |
|------|-------|-------|--------|
| +0.0s | — | contract_write | clone A, scope: docs/research |
| +0.1s | — | contract_write | clone B, scope: docs/research |
| +0.2s | — | contract_write | clone C, scope: docs/research |
| +2.1s | A | register | worktree: .manta/worktrees/clone-A |
| +3.4s | B | register | worktree: .manta/worktrees/clone-B |
| +5.2s | C | register | worktree: .manta/worktrees/clone-C |

## Phase: Working
| Time | Clone | Event | Detail |
|------|-------|-------|--------|
| +6.0s | A | heartbeat | state=WORKING |
| +6.1s | A | contract_ack | "Research Phase 2d replay..." |
| +7.2s | B | heartbeat | state=WORKING |
| ... | | | |
| +45.3s | A | lock | resource=docs/research/phase-2d-x.md |
| +89.1s | C | broadcast | "Found forensics.ts pattern" |

## Phase: Death
| Time | Clone | Event | Detail |
|------|-------|-------|--------|
| +120.5s | B | suicide_intent | reason="task complete" |
| +121.0s | B | zk_write | tags=[clone-B, cast-...] |
| +122.3s | B | death | death_reason="graceful" |
| +122.5s | B | post_mortem | path=docs/post-mortems/2026-05-26-cast-...-B.md |
| ... | | | |

## Phase: Review
| Time | Clone | Event | Detail |
|------|-------|-------|--------|
| +180.0s | — | merge_review | verdict=auto_merge_eligible, winner=A (0.847) |
| +200.0s | — | promote | winner=A, losers_graveyarded=[B, C] |

## Summary
| Clone | Registered | First Heartbeat | Died | Lifespan | Death Reason |
|-------|------------|-----------------|------|----------|--------------|
| A | +2.1s | +6.0s | +135.2s | 133.1s | graceful |
| B | +3.4s | +7.2s | +122.3s | 118.9s | graceful |
| C | +5.2s | +8.8s | +140.1s | 134.9s | graceful |

Post-mortems: docs/post-mortems/2026-05-26-cast-...-{A,B,C}.md
Merge review: .manta/merge-reviews/cast-1779812169241.md
```

### CLI Interface

```typescript
interface RunReplayOptions {
  castId: string;
  reporter: Reporter;
  format?: 'markdown' | 'json';  // default: markdown
  since?: number;                  // epoch ms — show events after this time
  cloneFilter?: string[];         // show only these clones (default: all roster)
}
```

**Argument parsing** follows `promote.ts` pattern: positional `<castId>` required.

```
manta replay <castId>                    # full timeline, markdown
manta replay <castId> --format json      # machine-readable JSON
manta replay <castId> --clone A --clone B  # filter to specific clones
manta replay <castId> --since 1779812000000  # events after timestamp
```

### Implementation Location

- `packages/manta-cli/src/commands/replay.ts` — CLI command (`runReplayCommand`)
- `packages/manta-orchestrator/src/replay.ts` — timeline reconstruction logic
  - `reconstructTimeline(ctx, castId, opts)` → `ReplayTimeline`
  - `renderReplayMarkdown(timeline)` → `string`
  - `renderReplayJson(timeline)` → `object`

Split: orchestrator owns the data assembly (it knows BusContext); CLI owns argv
parsing and output rendering. Same split as `post-mortem.ts` + `post-mortem-writer.ts`.

### Bug #12 Resolution: Lift Forensics Into Production Path

Bug #12 (docs/manta-bugs.md): forensic timeline JSON is produced only by the e2e
test harness (`recon-swarm.e2e.test.ts` lines 84–191 — the `timelinePolls` array
and `e2e-timeline-<cast-id>.json` writer). Production casts produce no equivalent.

**Resolution strategy:**

1. Extract the timeline polling concept from e2e into `@manta/orchestrator` as
   `ForensicTimeline` — a structured JSON representation of cast lifecycle that
   `replay` can consume.

2. The orchestrator's cast loop already runs periodic cycles (death-detector,
   lock-reaper, claim-reaper). Add a `timelineAppend` call at each cycle that
   writes a snapshot of clone states to a `timeline.jsonl` file under
   `.manta/state/timelines/<castId>.jsonl`.

3. On cast completion (all clones DEAD + merge-review done), the timeline file
   is "sealed" with a summary line.

4. `manta replay` reads this timeline JSONL as its primary data source, falling
   back to reconstructing from `events.jsonl` if the timeline file is missing
   (backward compat with casts that ran before this feature).

5. The e2e test switches from its bespoke polling loop to consuming the
   production timeline file — one code path for both.

**Type definition:**

```typescript
interface TimelineSnapshot {
  ts: number;
  cycle_number: number;
  clones: Array<{
    clone_id: string;
    state: CloneState;
    last_heartbeat_at: number;
    progress?: string;
    death_reason?: string;
    died_at?: number;
  }>;
}

interface ForensicTimeline {
  cast_id: string;
  mode: string;
  started_at: number;
  finished_at: number | null;
  duration_ms: number | null;
  sealed: boolean;
  snapshots: TimelineSnapshot[];
}
```

**Files changed:**
- NEW: `packages/manta-orchestrator/src/forensic-timeline.ts` (extract from e2e)
- EDIT: `packages/manta-orchestrator/src/cycle.ts` (add timeline append per cycle)
- EDIT: `packages/manta-e2e/tests/recon-swarm.e2e.test.ts` (consume production timeline)
- Status of bug #12: **Fixed** once this lands.

---

## `/manta audit <cloneId>` Design

### Purpose

Tier 4 forensic command (spec §11.0). Action audit log for a single clone: every
MCP call the clone made (or was affected by), every state transition, chronologically.
Answers: "What exactly did clone X do, in what order, and how long between actions?"

### Data Sources

| # | Source | Filter | Data |
|---|--------|--------|------|
| 1 | **Events log** | `event.clone_id === cloneId` | All events attributed to this clone |
| 2 | **Registry record** | `Registry.get(cloneId)` | Terminal state, metadata, timing |

Audit is simpler than replay: single-clone scope, no cross-clone interleaving,
no merge-review aggregation.

### Complete Event Type Catalog

These are all event types the bus currently emits (extracted from
`packages/manta-bus/src/tools/`):

| Event Type | Source Handler | Has `clone_id`? | Payload Fields |
|------------|---------------|-----------------|----------------|
| `register` | lifecycle.ts | yes | clone_id, mode, worktree |
| `heartbeat` | lifecycle.ts | yes | state, progress? |
| `suicide_intent` | lifecycle.ts | yes | reason |
| `death` | lifecycle.ts | yes | reason, death_reason |
| `contract_write` | contract.ts | yes | clone_id, mode, task (truncated) |
| `contract_ack` | contract.ts | yes | interpretation |
| `contract_refresh` | contract.ts | yes | new_task |
| `claim` | work.ts | yes | resource |
| `release` | work.ts | yes | resource |
| `lock` | locks.ts | yes | resource |
| `unlock` | locks.ts | yes | resource |
| `renew_lock` | locks.ts | yes | resource, ttl_ms |
| `broadcast` | communication.ts | yes | message |
| `message` | communication.ts | yes | to, body |
| `drift_report` | communication.ts | yes | delta |
| `zk_write` | memory.ts | yes | content (truncated), tags |
| `para_append` | memory.ts | yes | domain, key |

Orchestrator-emitted events (clone_id present but emitted by orchestrator, not clone):

| Event Type | Source | Notes |
|------------|--------|-------|
| `post_mortem` | post-mortem.ts | clone_id = subject clone |
| `lock_reap` | lock-reaper.ts | clone_id = lock owner |
| `claim_reap` | claim-reaper.ts | clone_id = claim owner |
| `merge_review` | merge-review.ts | no clone_id; payload.cast_id |
| `promote` | promote.ts (CLI) | no clone_id; payload.winner_clone_id |

### Output Format

Chronological table with relative timestamps from clone registration:

```markdown
# Audit — clone A (cast-1779812169241)

**Mode:** recon-swarm | **Registered:** 2026-05-26T16:16:15Z | **Died:** 2026-05-26T16:18:30Z

| Offset | Type | Detail | Δ prev |
|--------|------|--------|--------|
| +0.0s | register | mode=recon-swarm, worktree=.manta/worktrees/clone-A | — |
| +3.9s | heartbeat | state=WORKING | 3.9s |
| +4.1s | contract_ack | "Research Phase 2d replay and audit..." | 0.2s |
| +15.3s | lock | resource=docs/research/phase-2d-replay.md | 11.2s |
| +45.8s | broadcast | "Found forensics.ts is e2e-only..." | 30.5s |
| +78.2s | zk_write | tags=[clone-A, cast-...] | 32.4s |
| +80.1s | unlock | resource=docs/research/phase-2d-replay.md | 1.9s |
| +82.0s | suicide_intent | reason="task complete" | 1.9s |
| +83.5s | zk_write | tags=[clone-A, cast-...] "most surprising..." | 1.5s |
| +84.0s | death | death_reason="graceful" | 0.5s |
| +84.2s | post_mortem | path=docs/post-mortems/2026-05-26-...-A.md | 0.2s |

**Total events:** 11 | **Lifespan:** 84.2s | **Avg gap:** 8.4s | **Max gap:** 32.4s

## Gap Analysis
- Longest gap: +45.8s → +78.2s (32.4s) — likely reading/drafting phase
- Heartbeat gaps > 30s: 1 occurrence (within 90s threshold)
```

### Filtering Options

```
manta audit <cloneId>                           # all events
manta audit <cloneId> --type heartbeat          # only heartbeats
manta audit <cloneId> --type lock,unlock,claim  # resource ops only
manta audit <cloneId> --since 1779812100000     # events after timestamp
manta audit <cloneId> --limit 50                # last 50 events
manta audit <cloneId> --format json             # machine-readable
manta audit <cloneId> --gaps                    # highlight gaps > threshold
manta audit <cloneId> --gaps --gap-threshold 60000  # custom gap threshold (ms)
```

**Type filter groups** (convenience aliases):

| Group | Event types included |
|-------|---------------------|
| `lifecycle` | register, heartbeat, suicide_intent, death |
| `contract` | contract_write, contract_ack, contract_refresh |
| `resources` | lock, unlock, renew_lock, claim, release |
| `communication` | broadcast, message, drift_report |
| `knowledge` | zk_write, para_append |
| `orchestrator` | post_mortem, lock_reap, claim_reap |

### CLI Interface

```typescript
interface RunAuditOptions {
  cloneId: string;
  reporter: Reporter;
  format?: 'markdown' | 'json';
  typeFilter?: string[];        // event types or group names
  since?: number;               // epoch ms
  limit?: number;               // max events to show
  showGaps?: boolean;           // highlight inter-event gaps
  gapThresholdMs?: number;      // default: 30000 (30s)
}
```

### Implementation Location

- `packages/manta-cli/src/commands/audit.ts` — CLI command (`runAuditCommand`)
- `packages/manta-orchestrator/src/audit.ts` — audit log assembly
  - `buildAuditLog(ctx, cloneId, opts)` → `AuditLog`
  - `renderAuditMarkdown(log)` → `string`
  - `renderAuditJson(log)` → `object`

### Clone-to-Cast Resolution

`audit` takes a `cloneId`, not a `castId`. To show cast context in the header,
resolve via `Registry.get(cloneId).metadata.cast_id`. If the clone has no cast_id
in metadata (pre-Phase-2 clones), show `cast: unknown`.

---

## End-to-End Forking-Realities Test Strategy

### Purpose

Prove the forking-realities cast mode works end-to-end with real `claude --print`
clones: 2+ clones get distinct approaches, produce diffable output, merge-review
scores them, promote merges the winner. Analogous to the existing
`recon-swarm.e2e.test.ts` but covering the forking-realities-specific lifecycle.

### Test Structure

```typescript
// packages/manta-e2e/tests/forking-realities.e2e.test.ts

describe('forking-realities end-to-end against real claude', () => {
  // Gated by MANTA_E2E=1, same as recon-swarm e2e
  // Uses makeSampleRepo() from helpers/sampleRepo.ts
  // Timeline recorder same pattern as recon-swarm (or production ForensicTimeline)

  it('runs a 2-clone forking-realities cast, scores, and promotes winner', async () => {
    // ... see assertions below
  }, 28 * 60 * 1000);
});
```

**Gating:** `MANTA_E2E=1` environment variable, identical to recon-swarm.
Skip with console.warn if `probeClaudeBin()` reports unavailable.

### What to Assert

```
1. Cast process exits 0
2. Registry: exactly 2 clones, both DEAD
3. Each clone committed to its worktree branch:
   - `git -C <worktree> log --oneline` shows at least 1 commit
   - Deliverable file exists at the expected path
4. Merge-review ran:
   - events.jsonl contains a `merge_review` event with `payload.cast_id === castId`
   - Merge-review markdown exists at .manta/merge-reviews/<castId>.md
   - Verdict is one of: auto_merge_eligible | manual_review_required
   - Scores array has length === 2 (one per clone)
5. Promote is NOT auto-run (forking-realities default: manual_review_required
   because policy.auto_merge_threshold defaults to null)
   OR if auto_merge_threshold is set, promote event exists
6. Post-mortems: ≥ 2 markdown files, one per clone
7. ZK notes: ≥ 2 (one per clone, per manta-graceful-death skill requirement)
8. Clone assignments: each clone's contract has a distinct `assignment` field
   (the "approach hint" that differentiates forking-realities from recon-swarm)
9. Worktrees retained (same as recon-swarm — graveyard happens only after promote)
10. Forensic timeline JSONL exists (bug #12 resolution validation)
```

### Task Contract for the Test

The task must be:
- Simple enough for haiku-class models to complete in < 5 minutes
- Produce diffable output (two clones produce different solutions)
- Have a clear "better" solution (so scoring is non-trivial)
- Self-contained within the sample repo

**Proposed task:**

```
Refactor src/auth.ts to extract the validation logic into a separate function.
Approach A: Extract as a pure function `validateCredentials(user, pass) → boolean`.
Approach B: Extract as a class `CredentialValidator` with a `validate` method.
Both approaches must pass the existing tests. Produce the refactored file.
```

**Why this works:**
- Both approaches are valid; haiku can produce either
- The diff is meaningful (function vs class)
- Scoring will see different complexity deltas, diff sizes
- Tests pass for both (existing sample repo has auth.ts with inline validation)
- `assignment` field in the contract distinguishes: clone A gets "pure function",
  clone B gets "class-based"

**Cast invocation:**

```bash
node $CLI cast forking-realities \
  --clones 2 \
  --task "Refactor src/auth.ts to extract validation logic" \
  --assignments '["Extract as pure function validateCredentials","Extract as class CredentialValidator"]' \
  --cycle-interval-ms 5000 \
  --tick-budget-ms 1500000 \
  --budget-per-clone-usd 5
```

### Fixture Design

**Sample repo enhancement** (extend `packages/manta-e2e/tests/fixtures/sample-repo/`):

The existing sample repo already has `src/auth.ts`, `src/billing.ts`, `src/logging.ts`,
`src/index.ts`. The `auth.ts` file needs inline validation logic that's extractable:

```typescript
// src/auth.ts — needs to contain something like:
export function authenticate(user: string, pass: string): boolean {
  if (!user || user.length < 3) return false;
  if (!pass || pass.length < 8) return false;
  if (user === 'admin' && pass === 'admin123') return true;
  return false;
}
```

Add a simple test file `src/auth.test.ts`:

```typescript
import { authenticate } from './auth';

test('rejects empty user', () => expect(authenticate('', 'password123')).toBe(false));
test('rejects short password', () => expect(authenticate('admin', 'short')).toBe(false));
test('accepts valid admin', () => expect(authenticate('admin', 'admin123')).toBe(true));
```

**Fixture helper changes:**
- `makeSampleRepo()` already creates the repo with git init + initial commit
- Add `auth.test.ts` to the fixture so `pnpm test` can validate both approaches
- Optionally: add a minimal `vitest.config.ts` + `package.json` with vitest dep
  so the sample repo is independently testable

### Timeline Recorder

Use the production `ForensicTimeline` (from bug #12 resolution) instead of the
bespoke polling loop in recon-swarm.e2e.test.ts. The forking-realities e2e becomes
the first consumer of the production timeline writer, validating both the test and
the feature simultaneously.

If production ForensicTimeline is not yet available (phased delivery), fall back
to the same polling pattern from recon-swarm e2e.

---

## Test Strategy for Replay/Audit Commands

### Unit Tests

Located in `packages/manta-orchestrator/tests/`.

#### Replay Unit Tests (`replay.test.ts`)

```
1. reconstructTimeline — empty events returns empty phases
2. reconstructTimeline — filters events by roster clone_ids only
3. reconstructTimeline — includes cast-level events (merge_review, promote)
4. reconstructTimeline — preserves file order (does NOT re-sort by ts)
5. reconstructTimeline — handles missing clones in registry gracefully
6. reconstructTimeline — clone filter option restricts output
7. reconstructTimeline — since option filters by timestamp
8. renderReplayMarkdown — correct header with mode, clones, created_at
9. renderReplayMarkdown — phase grouping: spawn events before working events
10. renderReplayMarkdown — relative timestamps from cast created_at
11. renderReplayMarkdown — summary table with per-clone lifespan
12. renderReplayMarkdown — includes merge-review verdict and scores
13. renderReplayMarkdown — handles cast with no merge_review event
14. renderReplayJson — returns structured object matching ForensicTimeline shape
```

**Test fixtures:** Use `InMemoryPostMortemWriter` pattern — create an in-memory
BusContext with prepopulated events and registry records. No filesystem needed.

#### Audit Unit Tests (`audit.test.ts`)

```
1. buildAuditLog — filters events by exact clone_id match
2. buildAuditLog — calculates relative offsets from registered_at
3. buildAuditLog — calculates inter-event gaps (Δ prev)
4. buildAuditLog — type filter restricts to specified event types
5. buildAuditLog — type group filter expands to constituent types
6. buildAuditLog — since filter works on absolute timestamp
7. buildAuditLog — limit returns last N events (tail, not head)
8. buildAuditLog — clone not found throws BusNotFoundError
9. renderAuditMarkdown — correct header with clone metadata
10. renderAuditMarkdown — gap analysis section highlights gaps > threshold
11. renderAuditMarkdown — summary stats (total events, lifespan, avg/max gap)
12. renderAuditMarkdown — empty event list renders cleanly
13. renderAuditJson — returns array of typed event objects
14. formatEventDetail — truncates long payload fields (broadcast messages, zk content)
```

#### ForensicTimeline Unit Tests (`forensic-timeline.test.ts`)

```
1. appendSnapshot — writes JSONL line with correct schema
2. appendSnapshot — sequential appends are ordered
3. seal — sets finished_at and sealed flag
4. readTimeline — parses JSONL into ForensicTimeline
5. readTimeline — tolerates truncated last line (same as EventsLog)
6. readTimeline — returns null for missing file
```

### Integration Tests

Located in `packages/manta-cli/tests/`.

#### Replay Integration Test (`commands/replay.test.ts`)

```
1. runReplayCommand — reads cast manifest + events + registry, renders markdown
2. runReplayCommand — cast not found → CliError(not_found)
3. runReplayCommand — --format json → valid JSON output
4. runReplayCommand — --clone filter → only specified clones in output
5. runReplayCommand — exitCode 0, stdout contains "# Replay —"
```

**Setup:** Use `createRuntime()` with a temp directory, populate `.manta/state/`
with a cast manifest JSON, events.jsonl with known events, and registry.json with
clone records. Pattern matches `promote.test.ts` integration approach.

#### Audit Integration Test (`commands/audit.test.ts`)

```
1. runAuditCommand — reads events filtered by clone_id, renders markdown
2. runAuditCommand — clone not found → CliError(not_found)
3. runAuditCommand — --type heartbeat → only heartbeat events in output
4. runAuditCommand — --type lifecycle → expands to register,heartbeat,suicide_intent,death
5. runAuditCommand — --gaps → gap analysis section present
6. runAuditCommand — --format json → valid JSON array
7. runAuditCommand — --limit 5 → at most 5 events in output
8. runAuditCommand — exitCode 0, stdout contains "# Audit —"
```

### Event Fixture Factory

Both replay and audit tests need realistic event sequences. Create a shared
fixture factory:

```typescript
// packages/manta-orchestrator/tests/fixtures/event-factory.ts

export function createCastEventSequence(opts: {
  castId: string;
  cloneIds: string[];
  startTs: number;
}): BusEvent[] {
  // Returns a realistic sequence: contract_write × N, register × N,
  // heartbeat × N, work events, suicide_intent × N, death × N,
  // post_mortem × N, merge_review
}
```

This avoids duplicating event construction across 6+ test files and ensures
consistent event shapes.

### Coverage Targets

| Package | File | Target |
|---------|------|--------|
| `@manta/orchestrator` | `replay.ts` | ≥ 90% line coverage |
| `@manta/orchestrator` | `audit.ts` | ≥ 90% line coverage |
| `@manta/orchestrator` | `forensic-timeline.ts` | ≥ 85% line coverage |
| `@manta/cli` | `commands/replay.ts` | ≥ 80% line coverage |
| `@manta/cli` | `commands/audit.ts` | ≥ 80% line coverage |

---

## Implementation Order (Recommended)

1. **ForensicTimeline** extraction (bug #12 fix) — unlocks replay data source
2. **Audit** command — simpler (single-clone filter), validates event reading pipeline
3. **Replay** command — builds on audit's event reading + adds cross-clone interleaving
4. **Forking-realities e2e test** — requires merge-review to be wired (Phase 2c done), validates full lifecycle
5. **Replay/audit tests** — unit tests written alongside each command, integration tests after CLI wiring

Each step is an atomic commit. No step depends on a later step.

---

## Open Questions for Main

1. **replay output destination:** Stdout only, or also write to `.manta/replays/<castId>.md`?
   Recommendation: stdout only (consistent with `status`, `inspect`). Operator pipes
   to file if needed.

2. **audit gap threshold default:** 30s matches the old heartbeat timeout. Should it
   be 90s to match current `heartbeatTimeoutMs`? Recommendation: 30s — gaps > 30s
   are interesting even if not failures.

3. **ForensicTimeline cycle frequency:** Every orchestrator cycle (5s default) or
   every Nth cycle? Recommendation: every cycle — the JSONL lines are tiny (~200 bytes).

4. **Forking-realities e2e model:** haiku (fast, cheap) or sonnet (more reliable)?
   Recommendation: haiku, same as recon-swarm e2e — cost matters for frequent CI.
