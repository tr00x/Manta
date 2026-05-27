# Phase 4 — Test Coverage & Integration Surface Map

Clone C research deliverable for cast-1779890518943.

---

## Part 1 — Existing Test Map

### 1.1 Test Census

97 test files, 12,612 lines total across 6 packages:

| Package | Files | Lines | Tier |
|---------|-------|-------|------|
| manta-cli | 43 | 5,698 | Unit + Integration |
| manta-bus | 29 | 3,676 | Unit + Integration |
| manta-orchestrator | 17 | 1,862 | Unit + Integration |
| manta-snapshot | 8 | 615 | Unit |
| manta-skill-validator | 6 | 307 | Unit + Integration |
| manta-e2e | 4 | 697 | E2e |

### 1.2 Per-File Breakdown

#### `@manta/bus` (29 files, 3,676 lines)

| File | Lines | Coverage |
|------|-------|----------|
| `tests/state/casts.ts` | 455 | CastsStore CRUD, manifest creation, mode+roster validation |
| `tests/server.test.ts` | 398 | MCP server tool registration, stdio transport, config validation |
| `tests/state/charge-schemas.test.ts` | 300 | MODE_CHARGE_COST mapping all 10 modes, ChargeState schema, DailySpend schema |
| `tests/state/registry.test.ts` | 262 | Clone register/list/markDead, DEAD re-registration (bug #16) |
| `tests/integration.test.ts` | 233 | Full tool roundtrip through BusContext |
| `tests/tools/forking-isolation.test.ts` | 218 | Strategy 1 boundaries: message, broadcast, contract_read, claim_work |
| `tests/atomicity.test.ts` | 187 | Concurrent file ops, atomic read-modify-write |
| `tests/tools/communication-forking.test.ts` | 166 | Forking-realities peer messaging denied/allowed |
| `tests/state/daily-spend.test.ts` | 138 | Daily spend ledger, recordCastStart, getRemaining |
| `tests/tools/memory.test.ts` | 124 | zk_write/zk_read/para_append |
| `tests/schema.test.ts` | 121 | ModeSchema, CloneStateSchema, CastManifestSchema validation |
| `tests/state/contracts.test.ts` | 119 | TaskContract write/read/ack |
| `tests/tools/lifecycle.test.ts` | 118 | heartbeat, suicide_intent, report_death |
| `tests/state/locks.test.ts` | 114 | Lock acquire/release/expiry |
| `tests/tools/contract-forking.test.ts` | 110 | Contract read isolation in forking-realities |
| `tests/atomic-fs.test.ts` | 108 | atomicWriteJSON, atomicAppend |
| `tests/tools/contract.test.ts` | 87 | Contract handlers normal flow |
| `tests/tools/communication.test.ts` | 90 | message, broadcast (non-forking) |
| `tests/state/events.test.ts` | 84 | EventsLog append/readAll |
| `tests/integration/cast-manifest.test.ts` | 82 | CastManifest through bus context |
| `tests/state/claims.test.ts` | 82 | Work claim/release |
| `tests/tools/work-forking.test.ts` | 76 | claim_work rejection in forking-realities |
| `tests/tools/work.test.ts` | 72 | claim/release normal flow |
| `tests/bin.test.ts` | 70 | Server binary startup/shutdown |
| `tests/tools/locks.test.ts` | 67 | Lock tool handlers |
| `tests/state/paths.test.ts` | 60 | BusPaths construction |
| `tests/errors.test.ts` | 43 | Error class construction |
| `tests/state/canonicalize.test.ts` | 32 | JSON canonicalization |
| `tests/clock.test.ts` | 28 | systemClock monotonicity |

#### `@manta/cli` (43 files, 5,698 lines)

| File | Lines | Coverage |
|------|-------|----------|
| `tests/commands/cast.test.ts` | 625 | Cast command: mode validation, clone spawning, tick loop, settlement |
| `tests/spawner/clone-spawner.test.ts` | 361 | Clone process spawn, env vars, fake runner |
| `tests/spawner/pre-register.test.ts` | 198 | Pre-registration flow |
| `tests/integration/merge-review.test.ts` | 196 | Scoring pipeline, rubric pre-pass, verdict determination |
| `tests/budget/pre-spawn-gate.test.ts` | 189 | Budget checks: charge+daily cap, force override, dry-run |
| `tests/commands/tail.test.ts` | 180 | Tail formatting, event filtering |
| `tests/spawner/tasks-file.test.ts` | 161 | YAML tasks parsing, per-clone assignments |
| `tests/integration/charge-budget.test.ts` | 158 | 7 charge scenarios: happy, exhaustion, daily cap, recovery, cooldown, fail, neutral |
| `tests/tick-loop.test.ts` | 154 | Tick loop: heartbeat check, death detection, budget timeout |
| `tests/commands/inspect.test.ts` | 149 | Inspect command formatting |
| `tests/commands/audit.test.ts` | 140 | Audit command: timeline+events aggregation |
| `tests/commands/replay.test.ts` | 141 | Replay command: timeline parsing |
| `tests/spawner/heartbeat-hook.test.ts` | 134 | Heartbeat hook settings.json generation |
| `tests/config/budget-config.test.ts` | 121 | Budget config load/defaults/override |
| `tests/output/inspect-renderer.test.ts` | 120 | Inspector output formatting |
| `tests/commands/limit.test.ts` | 118 | Limit get/set command |
| `tests/integration/forking-isolation.test.ts` | 109 | Strategy 1 boundaries in full cast |
| `tests/spawner/startup-sequence.test.ts` | 103 | Clone startup validation |
| `tests/budget/cast-outcome.test.ts` | 105 | Outcome classification: success/fail/neutral |
| `tests/commands/refresh.test.ts` | 99 | Refresh command |
| `tests/integration.test.ts` | 99 | CLI integration smoke |
| `tests/integration/forking-spawn.test.ts` | 99 | FR spawn: manifest, registry metadata, contracts |
| `tests/budget/auto-downgrade.test.ts` | 74 | Auto-downgrade option computation |
| `tests/commands/cost.test.ts` | 74 | Cost command output |
| `tests/spawner/worktree.test.ts` | 74 | Worktree add/remove/list |
| `tests/commands/abort.test.ts` | 75 | Abort command |
| `tests/commands/charges.test.ts` | 75 | Charges command output |
| `tests/output/format.test.ts` | 73 | Output formatting utilities |
| `tests/spawner/graveyard.test.ts` | 68 | Graveyard cleanup |
| `tests/budget/cost-estimator.test.ts` | 64 | Cost estimation per mode/clone count |
| `tests/runtime.test.ts` | 64 | Runtime creation |
| `tests/spawner/snapshot-builder.test.ts` | 62 | Snapshot construction |
| `tests/commands/cast-mcp-preflight.test.ts` | 59 | MCP bus registration check |
| `tests/commands/rubric-prepass.test.ts` | 57 | Weight adjustment from tsconfig |
| `tests/output/status-table.test.ts` | 54 | Status table rendering |
| `tests/output/tail-formatter.test.ts` | 51 | Tail output formatting |
| `tests/commands/kill.test.ts` | 50 | Kill command |
| `tests/commands/status.test.ts` | 41 | Status command |
| `tests/commands/recover.test.ts` | 53 | Recover command |
| `tests/util/sleep.test.ts` | 29 | Sleep utility |
| `tests/errors.test.ts` | 25 | CliError construction |
| `tests/output/reporter.test.ts` | 23 | Reporter interface |

#### `@manta/orchestrator` (17 files, 1,862 lines)

| File | Lines | Coverage |
|------|-------|----------|
| `tests/merge-review.test.ts` | 350 | Full review pipeline, verdicts, tie-breaking, anomalies |
| `tests/scoring.test.ts` | 276 | Normalization, ranking, dominance inversion, epsilon ties |
| `tests/replay.test.ts` | 244 | Timeline replay |
| `tests/audit.test.ts` | 174 | Cast audit: history aggregation |
| `tests/forensic-timeline.test.ts` | 154 | Timeline writer: append, seal, read |
| `tests/orchestrator.test.ts` | 119 | Orchestrator tick lifecycle |
| `tests/death-detector.test.ts` | 107 | Death detection: heartbeat timeout, startup grace |
| `tests/post-mortem.test.ts` | 98 | Post-mortem generation |
| `tests/integration.test.ts` | 82 | Orchestrator integration |
| `tests/merge-review-writer.test.ts` | 66 | Merge-review markdown writer |
| `tests/post-mortem-writer.test.ts` | 71 | Post-mortem markdown writer |
| `tests/lock-reaper.test.ts` | 38 | Lock expiry reaping |
| `tests/claim-reaper.test.ts` | 37 | Claim expiry reaping |
| `tests/parent-pid.test.ts` | 35 | Parent PID check |
| `tests/status.test.ts` | 29 | Status aggregation |
| `tests/thresholds.test.ts` | 24 | Threshold defaults |
| `tests/errors.test.ts` | 20 | OrchestratorError construction |

#### `@manta/snapshot` (8 files, 615 lines)

| File | Lines | Coverage |
|------|-------|----------|
| `tests/distill.test.ts` | 126 | Snapshot distillation |
| `tests/deserialize.test.ts` | 91 | JSON deserialization |
| `tests/capture.test.ts` | 87 | Snapshot capture |
| `tests/schema.test.ts` | 82 | Schema validation (ModeSchema, ScopeSchema, SnapshotSchema) |
| `tests/serialize.test.ts` | 79 | JSON serialization |
| `tests/round-trip.test.ts` | 54 | Serialize → deserialize fidelity |
| `tests/version.test.ts` | 49 | Schema versioning |
| `tests/errors.test.ts` | 47 | SnapshotError construction |

#### `@manta/skill-validator` (6 files, 307 lines)

| File | Lines | Coverage |
|------|-------|----------|
| `tests/walk.test.ts` | 83 | Filesystem walking |
| `tests/validate.test.ts` | 81 | Validation rules |
| `tests/schemas.test.ts` | 50 | Schema compliance |
| `tests/parse.test.ts` | 45 | YAML/markdown parsing |
| `tests/integration.test.ts` | 36 | Full validateAll |
| `tests/errors.test.ts` | 12 | Error construction |

### 1.3 E2e Test Structure

All e2e tests live in `packages/manta-e2e/tests/` and share a common harness pattern:

#### Harness pattern (shared by recon-swarm + forking-realities e2e):
1. **Setup**: `probeClaudeBin()` — checks `claude --print` availability; `makeSampleRepo()` — creates temp git repo with `src/auth.ts`
2. **Launch**: `execa('node', [cliBin, 'cast', mode, ...flags])` — spawns CLI as subprocess
3. **Timeline recorder**: Async polling loop every 5s reading `Registry.list()`, recording state transitions. Enforces positive-timeline budget (`tickBudgetMs / 4`) — if clones haven't left STARTING by deadline, kills cast and throws (Bug #3 regression guard)
4. **Assertions**: Registry DEAD, post-mortems exist, ZK notes exist, snapshots exist, worktrees retained
5. **Cleanup**: `afterAll` — preserves evidence on failure (`MANTA_E2E_KEEP=1`)

#### `recon-swarm.e2e.test.ts` (244 lines, 1 test):
- Spawns 2 clones, task: "Map every public export in src/"
- Asserts: 2 clones DEAD, 2+ post-mortems, 2+ ZK notes, snapshots under `.manta/snapshots/cast-*/`, worktrees retained
- Timeout: 28 min

#### `forking-realities.e2e.test.ts` (284 lines, 1 test):
- Spawns 2 clones with tasks.yaml per-clone assignments
- Same base assertions as recon-swarm, PLUS:
  - Each worktree branch has ≥1 commit beyond main
  - `merge_review` event in events.jsonl with valid verdict
  - Merge-review markdown file at `docs/merge-reviews/<castId>.md`
  - Forensic timeline NDJSON at `.manta/state/timelines/<castId>.ndjson`
- Timeout: 28 min

#### `charge-system.e2e.test.ts` (130 lines, 2 tests):
- Smoke tests for CLI commands: `manta charges`, `manta cost`, `manta cost week`, `manta limit get/set`
- No real clones spawned — verifies output format and config persistence
- Checks charges.json idempotency after read-only commands

#### `preflight.test.ts` (39 lines, 3 tests):
- Build check: `pnpm -r build` succeeds
- Skill validator: 5 skills, 6 commands, zero errors
- CLI smoke: `manta status` runs on empty repo

### 1.4 Integration Test Structure

CLI integration tests at `packages/manta-cli/tests/integration/`:

#### `forking-spawn.test.ts` (99 lines, 1 test):
- Uses `runCastCommand()` with `runFakeCloneScript()` (no real Claude)
- Verifies: manifest creation, mode=forking-realities, peer_messaging=denied, per-clone assignments, registry cast_mode/cast_id metadata, contract task/approach_hint/sibling_clones

#### `forking-isolation.test.ts` (109 lines, 1 test):
- Full FR cast then probes all Strategy 1 boundaries:
  - Sibling-to-sibling message → `BusForkingIsolationError`
  - Cross-clone contract read → `BusForkingIsolationError`
  - Self-read → allowed
  - claim_work → `BusForkingIsolationError`
  - Broadcast → succeeds, payload stamped with cast_id + cast_mode

#### `merge-review.test.ts` (196 lines, 3 tests):
- Pipeline: 3 candidates, 1 disqualified (test_gate), winner identified
- Rubric pre-pass: tsconfig strict → typeCheck weight boost, weights sum to 1.0
- Edge case: all candidates fail gate → `no_candidates_passed_gate`

#### `charge-budget.test.ts` (158 lines, 7 tests):
- Scenario 1: Happy path (deduct → success → credit)
- Scenario 2: Charge exhaustion (forking-realities costs 2, have 1)
- Scenario 3: Daily cap enforcement
- Scenario 4: Passive recovery
- Scenario 5: Cooldown flow
- Scenario 6: Budget abort → FAIL → -1 charge
- Scenario 7: Manual kill → neutral → no charge change

---

## Part 2 — Phase 4 Test Plan

### 2.1 Tests for bug-hunt mode

#### Unit tests — `@manta/cli`

**`tests/commands/cast-bug-hunt.test.ts`** (new file, ~200 lines)
```
describe('cast command — bug-hunt mode')
  it('accepts bug-hunt as valid mode')
  it('rejects bug-hunt with 0 clones')
  it('caps bug-hunt at 2 clones per spec Sec 2 line 59')
  it('sets peer_messaging = allowed for bug-hunt (clones share findings)')
  it('does NOT trigger merge-review after bug-hunt (investigation, not competing)')
  it('populates task contract with bug description and layer assignment')
```

**`tests/spawner/priming-bug-hunt.test.ts`** (extend existing priming.test.ts, ~60 lines)
```
describe('buildPrimingText — bug-hunt')
  it('includes investigation-specific instructions instead of self_certainty block')
  it('includes layer assignment in approach hint')
  it('includes broadcast instructions for sharing findings between clones')
```

#### Unit tests — `@manta/bus`

**Extend `tests/tools/communication.test.ts`** (~30 lines)
```
describe('communication — bug-hunt mode')
  it('allows sibling-to-sibling messaging (peer_messaging=allowed)')
  it('broadcast payload stamped with cast_mode=bug-hunt')
```

#### Integration tests — `@manta/cli`

**`tests/integration/bug-hunt-spawn.test.ts`** (new, ~120 lines)
```
describe('bug-hunt spawn integration')
  it('spawns 2 clones with layer assignments; manifest.mode=bug-hunt; peer_messaging=allowed')
  it('each clone contract includes bug_description, assigned_layer, reproduction_steps')
  it('registry records carry cast_mode=bug-hunt')
  it('no merge-review event emitted after cast completion')
```

#### E2e tests — `@manta/e2e`

**`tests/bug-hunt.e2e.test.ts`** (new, ~250 lines)
```
describe('bug-hunt end-to-end against real claude')
  it('runs 2-clone bug-hunt; produces investigation reports; no merge-review')
    - Setup: sample repo with a seeded bug in src/auth.ts
    - Task: "Investigate authentication failure when password contains special chars"
    - Asserts:
      - 2 clones DEAD
      - Post-mortems exist per clone
      - ZK notes exist
      - Snapshots exist
      - NO merge-review event in events.jsonl
      - NO merge-review markdown in docs/merge-reviews/
      - Clone branches have commits (investigation reports)
      - Forensic timeline exists
```

#### Charge system integration

**Extend `tests/integration/charge-budget.test.ts`** (~40 lines)
```
  it('bug-hunt mode costs 2 charges — deduction and settlement')
  it('bug-hunt with 1 clone still costs 2 charges')
```

### 2.2 Tests for refactor-wave mode

#### Unit tests — `@manta/cli`

**`tests/commands/cast-refactor-wave.test.ts`** (new, ~250 lines)
```
describe('cast command — refactor-wave mode')
  it('accepts refactor-wave as valid mode')
  it('accepts N clones (no 2-clone cap unlike bug-hunt)')
  it('requires explicit module partitioning via cloneAssignments')
  it('rejects overlapping allowedPaths between clones')
  it('sets peer_messaging = denied (parallel independent writes)')
  it('triggers merge-ALL after cast (not merge-review pick-winner)')
  it('populates task contract with migration pattern + module scope')
```

**`tests/spawner/priming-refactor-wave.test.ts`** (extend, ~60 lines)
```
describe('buildPrimingText — refactor-wave')
  it('includes module assignment in approach block')
  it('does NOT include self_certainty block (no competition)')
  it('includes merge-all instructions (complementary, not competing)')
  it('warns clone about forbidden paths = other clones modules')
```

#### Unit tests — `@manta/orchestrator`

**`tests/merge-all.test.ts`** (new, ~200 lines)
```
describe('merge-all strategy (refactor-wave)')
  it('merges all clone branches sequentially')
  it('detects file-level merge conflicts between clones')
  it('escalates to manual when conflict detected')
  it('runs full test suite after merge-all completes')
  it('scores each clone independently (quality gate, not competition)')
  it('produces merge-all report markdown')
```

#### Integration tests — `@manta/cli`

**`tests/integration/refactor-wave-spawn.test.ts`** (new, ~150 lines)
```
describe('refactor-wave spawn integration')
  it('spawns N clones with disjoint module assignments')
  it('manifest.mode=refactor-wave; peer_messaging=denied')
  it('each clone scope.forbiddenPaths includes sibling module paths')
  it('cloneAssignments carry module list per clone')
  it('merge-all event emitted after cast (not merge_review)')
```

**`tests/integration/refactor-wave-isolation.test.ts`** (new, ~100 lines)
```
describe('refactor-wave isolation')
  it('sibling-to-sibling messaging rejected (parallel independent)')
  it('cross-clone contract read rejected')
  it('claim_work rejected (each clone owns its modules)')
  it('broadcast stamped with cast_mode=refactor-wave')
```

#### E2e tests — `@manta/e2e`

**`tests/refactor-wave.e2e.test.ts`** (new, ~300 lines)
```
describe('refactor-wave end-to-end against real claude')
  it('runs 3-clone refactor-wave; merges all branches; passes test suite')
    - Setup: sample repo with 3 modules (src/auth/, src/api/, src/db/)
    - Task: "Rename all snake_case function names to camelCase in your assigned module"
    - Assignments: A=src/auth/, B=src/api/, C=src/db/
    - Asserts:
      - 3 clones DEAD
      - Post-mortems exist
      - ZK notes exist
      - merge_all event in events.jsonl (not merge_review)
      - merge-all report markdown exists
      - Each clone branch has commits
      - Forensic timeline exists
      - No file conflicts (disjoint modules)
```

#### Charge system integration

**Extend `tests/integration/charge-budget.test.ts`** (~40 lines)
```
  it('refactor-wave mode costs 2 charges — deduction and settlement')
  it('refactor-wave with 5 clones still costs 2 charges (mode-based, not clone-based)')
```

---

## Part 3 — Shared Infrastructure Changes

### 3.1 ModeSchema — already has both modes

Both `@manta/bus` and `@manta/snapshot` ModeSchema enums already include `'bug-hunt'` and `'refactor-wave'` as reserved values:

- `packages/manta-snapshot/src/schema.ts:4-15` — 10-mode enum
- `packages/manta-bus/src/schema.ts:12-23` — same 10-mode enum

**No schema changes needed.** Both modes parse and validate today.

### 3.2 SUPPORTED_MODES gate — needs update

`packages/manta-cli/src/commands/cast.ts:29-32`:
```typescript
const SUPPORTED_MODES: ReadonlySet<Mode> = new Set<Mode>([
  'recon-swarm',
  'forking-realities',
]);
```

**Must add `'bug-hunt'` and `'refactor-wave'`** — this is the runtime gate that rejects unknown modes at `cast.ts:115-118`.

### 3.3 Mode-specific branching points — all locations needing new cases

| Location | Line | Current logic | Bug-hunt needs | Refactor-wave needs |
|----------|------|---------------|----------------|---------------------|
| `cast.ts:249` | castPolicy | FR → denied, else → allowed | allowed (share findings) | denied (parallel writes) |
| `cast.ts:427` | merge-review trigger | FR only | skip (no merge-review) | new merge-all logic |
| `priming.ts:31` | selfCertainty block | FR only | skip (not competing) | skip (not competing) |
| `clone-spawner.ts:154` | MANTA_BUS_PEER_SCOPE | FR → parent-only, else → siblings-allowed | siblings-allowed | parent-only |
| `work.ts:20` | claim_work rejection | FR → reject | allow (bug investigation may share) | reject (isolated modules) |

### 3.4 CastOutcomeClassifier — mode-agnostic, no changes needed

`packages/manta-cli/src/budget/cast-outcome.ts:24-38`:

The classifier inspects `budgetAborted`, infra failure patterns, and manual kill — all mode-independent heuristics. Both new modes (bug-hunt, refactor-wave) produce the same clone lifecycle (DEAD with death_reason), so existing classification works without changes.

**However**, consider: should a bug-hunt where clones found no bug be classified differently? Current logic returns `'success'` for any non-infra, non-manual DEAD clones. If the investigation report is empty, that's arguably `'neutral'`. **Recommendation**: defer to Phase 5 — classification granularity per mode outcome quality.

### 3.5 Merge-review scoring — forking-realities only

`packages/manta-orchestrator/src/merge-review.ts` and `scoring.ts`:

The entire merge-review system is designed for the **pick-winner** model (forking-realities). Scoring axes (coverage, diff, complexity, typeCheck, lint, perfBonus) compare candidates against each other. This doesn't apply to:

- **Bug-hunt**: no competition, no merge needed (investigation reports are standalone)
- **Refactor-wave**: complementary work, all branches merge (not pick-winner)

**For refactor-wave**, a new `merge-all.ts` module is needed:
1. Score each clone independently against a quality gate (not relative ranking)
2. Sequential merge of all branches
3. Conflict detection + escalation
4. Post-merge test suite run
5. Report generation

**For bug-hunt**, the merge-review system is not invoked at all.

### 3.6 ForensicTimelineWriter — mode-agnostic, minor enhancement possible

`packages/manta-orchestrator/src/forensic-timeline.ts:36-62`:

The writer stores `{ cast_id, mode, started_at }` metadata and appends `TimelineSnapshot` objects (clone states per cycle). The snapshot shape is mode-independent.

**Consider adding mode-specific event types**:
- Bug-hunt: `finding_shared` event when clone broadcasts an intermediate finding
- Refactor-wave: `module_complete` event when a clone finishes its assigned module

**Recommendation**: these are nice-to-have enrichments, not blockers. The existing timeline captures all state transitions. Mode-specific events can be added in a follow-up without schema changes (the NDJSON format is append-only and schema-less per line).

### 3.7 MODE_CHARGE_COST — already complete

`packages/manta-bus/src/state/charges.ts` maps all 10 modes including:
- `'bug-hunt': 2`
- `'refactor-wave': 2`

Test `tests/state/charge-schemas.test.ts:14-16` already verifies all modes are mapped. **No changes needed.**

### 3.8 Pre-spawn gate — works for new modes

`packages/manta-cli/src/budget/pre-spawn-gate.ts` uses `MODE_CHARGE_COST[mode]` for charge deduction and `config.costEstimates[mode]` for USD estimation. Both resolve for bug-hunt and refactor-wave. **No changes needed** — the gate is already mode-generic.

### 3.9 Auto-downgrade — works for new modes

`packages/manta-cli/src/budget/auto-downgrade.ts` computes fallback options across modes. Since both new modes are in ModeSchema and MODE_CHARGE_COST, downgrade computation already considers them. **No changes needed.**

---

## Summary — Phase 4 Test Work Estimate

| Category | New files | Est. lines | Priority |
|----------|-----------|------------|----------|
| Bug-hunt unit tests | 2 | ~260 | P0 |
| Bug-hunt integration | 1 | ~120 | P0 |
| Bug-hunt e2e | 1 | ~250 | P1 |
| Refactor-wave unit tests | 2 | ~310 | P0 |
| Refactor-wave merge-all tests | 1 | ~200 | P0 |
| Refactor-wave integration | 2 | ~250 | P0 |
| Refactor-wave e2e | 1 | ~300 | P1 |
| Charge system extensions | 0 (extend) | ~80 | P0 |
| **Total** | **10** | **~1,770** | |

### Critical path for implementation

1. Add `'bug-hunt'` and `'refactor-wave'` to `SUPPORTED_MODES` (`cast.ts:29`)
2. Add mode-specific branching in `cast.ts` (policy, merge trigger), `priming.ts` (mode text), `clone-spawner.ts` (peer scope), `work.ts` (claim policy)
3. Implement `merge-all.ts` in `@manta/orchestrator` for refactor-wave
4. Write unit + integration tests (P0 items above)
5. Write e2e tests (P1 — require real Claude, expensive to run)

### Existing test infrastructure reuse

The fake runner pattern (`runFakeCloneScript` in `clone-spawner.ts`) and `makeRepoFixture` in integration test helpers are fully reusable for both new modes. The e2e harness (`probeClaudeBin`, `makeSampleRepo`, timeline recorder) can be extracted into a shared `e2eHarness()` function to avoid duplication across the 4 e2e suites.
