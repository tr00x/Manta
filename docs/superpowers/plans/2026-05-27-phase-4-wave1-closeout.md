# Phase 4 — Wave-1 Closeout: `bug-hunt` + `refactor-wave`

**Spec reference:** Sec 2 (mode catalog), Sec 6.4 (charge costs), Sec 15.1 (Phase 4 scope)  
**Research deliverables:** `docs/research/phase-4-{mode-infra-and-bug-hunt,refactor-wave-design,test-and-integration-map}.md`  
**Build by:** heavy dogfood — forking-realities casts with 2 clones per chunk  
**Estimated total:** ~1,240 LOC (production code + tests + docs)

---

## Architecture Summary

Phase 4 adds the remaining two Wave-1 batch-spawn modes:

| Mode | Charge | Clones | Merge Strategy | Key New Component |
|------|--------|--------|----------------|-------------------|
| `bug-hunt` | 2 | 1–2 | No merge (investigation reports) | `read_broadcasts` MCP tool |
| `refactor-wave` | 2 | 2–5 | Merge-all (sequential) | `merge-all.ts` orchestrator |

**Infrastructure finding from research:** The existing codebase has only 2–3 mode-specific branches (in `cast.ts`, `priming.ts`, `clone-spawner.ts`). The orchestrator, charge system, forensic timeline, and bus infrastructure are fully mode-agnostic. Adding new modes is a matter of:
1. Adding to `SUPPORTED_MODES` set
2. Setting per-mode `castPolicy` (peer_messaging)
3. Choosing post-cast pipeline (merge-review / merge-all / report-only)
4. Writing mode-specific priming text

---

## Chunk 1 — `bug-hunt` Mode (Complete Feature)

**Cast mode:** `forking-realities` with 2 clones  
**Estimated LOC:** ~370 (code + tests + docs)

### Design Decisions (from research, Clone A)

- **Worktree model:** Isolated (clones may propose fixes in their layer)
- **Peer messaging:** `'allowed'` — clones share intermediate findings via `manta.broadcast`
- **Peer scope:** `'siblings-allowed'` — clones can read sibling broadcasts
- **Max clones:** 2 (spec says 1–2), enforced in `cast.ts`
- **Post-cast pipeline:** No merge-review (complementary investigation, not competing approaches). Reporter logs investigation report paths.
- **Deliverable format:** Freeform markdown investigation reports committed to clone branches

### Task 1.1 — `read_broadcasts` MCP tool (bus)

**Package:** `@manta/bus`  
**Files:**
- `packages/manta-bus/src/tools/communication.ts` — add `handleReadBroadcasts` handler
- `packages/manta-bus/src/schema.ts` — add `ReadBroadcastsInputSchema`
- `packages/manta-bus/src/server.ts` — register new tool
- `packages/manta-bus/src/index.ts` — re-export

**Behavior:**
```typescript
// ReadBroadcastsInputSchema
{
  clone_id: CloneIdSchema,       // caller clone
  cast_id: CastIdSchema,         // filter to own cast only
  since_index?: z.number(),      // optional: only events after this index
}

// Returns: array of broadcast events from this cast
// Filter: event.type === 'broadcast' && event.payload.cast_id === input.cast_id
// Excludes: caller's own broadcasts (clone_id !== input.clone_id)
```

Read from `events.jsonl`, filter by cast_id and type='broadcast', exclude own broadcasts. Return as JSON array.

**Tool name:** `manta.read_broadcasts` (snake_case, matching existing convention: `manta.broadcast`, `manta.claim_work`, etc.)

**Note on RegisterInputSchema:** The spawner (`clone-spawner.ts:117`) always sets `metadata.cast_id` for all modes. The schema refinement only validates format for `forking-realities` — this is acceptable because the spawner guarantee is sufficient. No schema change needed.

**Note on cast_id plumbing:** The clone obtains its `cast_id` from the priming preamble (`priming.ts` line 4: `cast_id={CAST_ID}`). The bug-hunt priming block (Task 1.3) should include the exact tool call shape: `manta.read_broadcasts({ clone_id: "<your-id>", cast_id: "<your-cast-id>" })`.

**Tests:** `tests/tools/communication.test.ts` — add section:
- `read_broadcasts returns sibling broadcasts from same cast`
- `read_broadcasts excludes own broadcasts`
- `read_broadcasts returns empty for different cast_id`
- `read_broadcasts respects since_index filter`
- `read_broadcasts works regardless of peer_messaging policy (reads always allowed)`

~25 LOC production, ~50 LOC tests.

### Task 1.2 — Add `bug-hunt` to `SUPPORTED_MODES` + cast.ts dispatch

**Package:** `@manta/cli`  
**File:** `packages/manta-cli/src/commands/cast.ts`

**Changes:**
1. Add `'bug-hunt'` to `SUPPORTED_MODES` set (line 29)
2. In `castPolicy` construction (line ~248): bug-hunt → `peer_messaging: 'allowed'` (falls into existing `else` branch, no change needed)
3. Add max-clone validation for bug-hunt:
```typescript
if (mode === 'bug-hunt' && cloneCount > 2) {
  throw new CliError('bug-hunt mode supports at most 2 clones (spec Sec 2)', { kind: 'invalid_input' });
}
```
4. In post-loop pipeline (line ~427): add `else if` branch for bug-hunt — no merge-review, just log investigation report paths:
```typescript
if (mode === 'forking-realities' && !aborted) {
  // existing merge-review pipeline
} else if (mode === 'bug-hunt') {
  reporter.info('cast.bug-hunt-complete', { cast: opts.castId, hint: 'Use manta inspect <cloneId> to review investigation reports' });
}
```

~15 LOC. Tests in task 1.5.

### Task 1.3 — Bug-hunt priming block

**Package:** `@manta/cli`  
**File:** `packages/manta-cli/src/spawner/priming.ts`

Add `BUG_HUNT_BLOCK` constant and inject when `mode === 'bug-hunt'`:

```typescript
const BUG_HUNT_BLOCK = `
## Investigation Protocol
You are investigating a bug as part of a bug-hunt cast. Your assigned layer is specified in your task contract.

INVESTIGATION WORKFLOW:
1. Read the bug description and reproduction steps from your task contract
2. Investigate your assigned layer systematically — read relevant source, trace data flow, check error handling
3. Broadcast intermediate findings via manta.broadcast so sibling clones in other layers can cross-reference
4. Read sibling findings via manta.read_broadcasts({ clone_id: "<your-id>", cast_id: "<your-cast-id>" }) to check for cross-layer correlations
5. Write your investigation report as a markdown file committed to your branch

REPORT SECTIONS: Symptom | Findings | Root Cause Hypothesis | Proposed Fix | Cross-Layer Dependencies
`;
```

~15 LOC. Tests in task 1.6.

### Task 1.4 — Clone spawner peer scope for bug-hunt

**Package:** `@manta/cli`  
**File:** `packages/manta-cli/src/spawner/clone-spawner.ts`

Bug-hunt falls into existing `else` branch (not forking-realities), so `MANTA_BUS_PEER_SCOPE` = `'siblings-allowed'` already. **No code change needed.** Verify in tests.

### Task 1.5 — Unit tests for bug-hunt cast dispatch

**Package:** `@manta/cli`  
**File:** `packages/manta-cli/tests/commands/cast.test.ts` (extend existing)

New `describe('cast command — bug-hunt mode')`:
- `accepts bug-hunt as valid mode`
- `rejects bug-hunt with cloneCount > 2`
- `sets peer_messaging = allowed`
- `does not trigger merge-review after cast`
- `reports investigation report paths`

~50 LOC tests.

### Task 1.6 — Unit tests for bug-hunt priming

**Package:** `@manta/cli`  
**File:** `packages/manta-cli/tests/spawner/priming.test.ts` (extend existing)

New section:
- `includes BUG_HUNT_BLOCK when mode is bug-hunt`
- `does not include SELF_CERTAINTY_BLOCK for bug-hunt`
- `includes approach_hint when provided`

~20 LOC tests.

### Task 1.7 — Integration test for bug-hunt lifecycle

**Package:** `@manta/cli`  
**File:** `packages/manta-cli/tests/integration/bug-hunt-spawn.test.ts` (new)

Full lifecycle with fake runner:
- Spawns 2 clones with layer assignments via cloneAssignments
- Manifest mode = 'bug-hunt', peer_messaging = 'allowed'
- Each clone contract includes bug description + layer
- Registry records carry cast_mode=bug-hunt
- No merge_review event emitted after cast completion
- Settlement: charge credit for success

~120 LOC.

### Task 1.8 — E2E smoke test for bug-hunt

**Package:** `@manta/e2e`  
**File:** `packages/manta-e2e/tests/bug-hunt.e2e.test.ts` (new)

Pattern: follow `forking-realities.e2e.test.ts` structure.
- 2-clone bug-hunt with fake runner
- Assert: both clones DEAD, post-mortems exist, NO merge-review event
- Assert: forensic timeline exists, charge system recorded cost=2

~200 LOC.

### Task 1.9 — Charge system integration test

**Package:** `@manta/cli`  
**File:** `packages/manta-cli/tests/integration/charge-budget.test.ts` (extend)

Add:
- `bug-hunt mode costs 2 charges — deduction and settlement`

~20 LOC.

### Task 1.10 — User docs for bug-hunt

**Package:** docs  
**File:** `docs/user/bug-hunt.md` (new)

Sections: When to use | How it works | CLI examples | Investigation report format | Tips

~60 LOC.

### Clone Assignment Strategy (Chunk 1)

**Clone A** — Implementation (tasks 1.1, 1.2, 1.3, 1.4):
- read_broadcasts MCP tool (bus-level, Clone A owns this shared prereq)
- cast.ts mode dispatch changes
- Priming block
- Spawner verification

**Clone B** — Tests + docs (tasks 1.5, 1.6, 1.7, 1.8, 1.9, 1.10):
- Unit tests for cast dispatch and priming
- Integration test for full lifecycle
- E2E smoke test
- Charge integration test
- User docs

**Shared prereq:** `read_broadcasts` schema + handler → Clone A only. Clone B writes tests against the interface from this plan (imports ReadBroadcastsInputSchema from @manta/bus after Clone A's merge).

**Note for Clone B:** The read_broadcasts handler and schema are created by Clone A. Your integration and e2e tests should import from `@manta/bus` after merge. In your worktree, write unit tests that mock the bus context (same pattern as existing cast.test.ts). For the e2e test, the fake runner doesn't call real MCP tools anyway.

---

## Chunk 2 — `refactor-wave` Mode (Complete Feature)

**Cast mode:** `forking-realities` with 2 clones  
**Estimated LOC:** ~870 (code + tests + docs)

### Design Decisions (from research, Clone B)

- **Worktree model:** Isolated per clone (reuses forking-realities infra)
- **Peer messaging:** `'denied'` — clones work independently on disjoint modules; `manta.broadcast` still works (only `manta.message` blocked by policy); research recommended `'allowed'` for boundary coordination but broadcasts suffice — direct messaging adds noise without value for independent parallel sweeps
- **Peer scope:** `'siblings-allowed'` — clones can READ sibling code for type context
- **Cross-clone reads (forking-isolation):** Allowed (only forking-realities blocks this in `forking-isolation.ts`)
- **Module partitioning:** Explicit via `cloneAssignments` (required, not optional like forking-realities)
- **Pre-spawn validation:** Disjoint partition check on `allowedPaths`
- **Post-cast pipeline:** `runMergeAll()` — sequential merge of all clone branches with per-clone quality gate
- **Scoring:** Per-clone pass/fail quality gate (not relative ranking)
- **Merge conflicts:** Escalate to operator (abort that clone's merge, continue others)

### Task 2.1 — `merge-all.ts` orchestrator

**Package:** `@manta/orchestrator`  
**File:** `packages/manta-orchestrator/src/merge-all.ts` (new)

Core algorithm from research (Clone B, §5.1):

```typescript
export interface MergeAllOptions {
  repoRoot: string;
  castId: string;
  deadClones: ReadonlyArray<{ cloneId: string; worktreePath: string; exitTime: number }>;
  runQualityGate: (worktreePath: string) => Promise<QualityGateResult>;
  gitMerge: (repoRoot: string, branch: string) => Promise<{ hasConflicts: boolean }>;
  gitMergeAbort: (repoRoot: string) => Promise<void>;
}

export interface MergeAllResult {
  verdict: 'all_merged' | 'partial_merge' | 'no_merges' | 'conflict_escalation';
  merged: string[];
  skipped: string[];
  conflicted: string[];
}

export async function runMergeAll(opts: MergeAllOptions): Promise<MergeAllResult>;
```

Quality gate axes (per clone):
1. Non-empty diff (skip silently if empty)
2. TypeScript compilation (`tsc --noEmit`)
3. Tests pass (`vitest run`)

Seam-based design: `runQualityGate`, `gitMerge`, `gitMergeAbort` are injected for testability.

~120 LOC.

### Task 2.2 — Merge-all report renderer

**Package:** `@manta/orchestrator`  
**File:** `packages/manta-orchestrator/src/merge-all-writer.ts` (new)

Markdown report to `docs/merge-all-reports/cast-<id>.md`:
- Verdict summary
- Per-clone quality gate results table
- Merge step log (merged / skipped / conflicted)
- Post-merge status

Pattern: follow `merge-review-writer.ts`.

~60 LOC.

### Task 2.3 — Orchestrator exports

**Package:** `@manta/orchestrator`  
**File:** `packages/manta-orchestrator/src/index.ts`

Re-export `runMergeAll`, `MergeAllResult`, `MergeAllOptions`, `MergeAllWriter`.

~5 LOC.

### Task 2.4 — Add `refactor-wave` to `SUPPORTED_MODES` + cast.ts dispatch

**Package:** `@manta/cli`  
**File:** `packages/manta-cli/src/commands/cast.ts`

Changes:
1. Add `'refactor-wave'` to `SUPPORTED_MODES` set (line 29)
2. In `castPolicy` construction: refactor-wave → `peer_messaging: 'denied'`
```typescript
const peerPolicy = (mode === 'forking-realities' || mode === 'refactor-wave')
  ? 'denied' as const
  : 'allowed' as const;
```
3. Add pre-spawn validation for disjoint partitions (see task 2.6)
4. Require `cloneAssignments` for refactor-wave:
```typescript
if (mode === 'refactor-wave' && !opts.cloneAssignments) {
  throw new CliError('refactor-wave requires --tasks with per-clone module assignments', { kind: 'invalid_input' });
}
```
5. Post-loop pipeline: add merge-all branch:
```typescript
} else if (mode === 'refactor-wave' && !aborted) {
  const mergeResult = await runMergeAll({ ... });
  await mergeAllWriter.write(mergeResult);
  reporter.info('cast.merge-all', { cast: opts.castId, verdict: mergeResult.verdict, merged: mergeResult.merged.join(', ') });
}
```

~40 LOC. Tests in task 2.8.

### Task 2.5 — Refactor-wave priming block

**Package:** `@manta/cli`  
**File:** `packages/manta-cli/src/spawner/priming.ts`

```typescript
const MODULE_BOUNDARY_BLOCK = `
## Module Assignment (refactor-wave)
You own a specific slice of the codebase defined in your task contract scope.

RULES:
1. Only modify files within your allowedPaths — other modules belong to sibling clones
2. If you need a type or interface from another module, import the CURRENT version (do not modify it)
3. If the migration pattern doesn't apply to any file in your module, commit an empty report and exit
4. Run tests for your module before completing: ensure your changes compile and pass
`;
```

~15 LOC. Tests in task 2.9.

### Task 2.6 — Disjoint partition validator

**Package:** `@manta/cli`  
**File:** `packages/manta-cli/src/commands/cast.ts` (inline function)

```typescript
function validateDisjointPartitions(assignments: Record<string, CloneAssignment>): void {
  const allPaths = new Map<string, string>(); // path → cloneId
  for (const [cloneId, assignment] of Object.entries(assignments)) {
    for (const p of assignment.scope?.allowedPaths ?? []) {
      const existing = allPaths.get(p);
      if (existing) {
        throw new CliError(
          `Overlapping partition: path "${p}" assigned to both ${existing} and ${cloneId}`,
          { kind: 'invalid_input' });
      }
      allPaths.set(p, cloneId);
    }
  }
}
```

Called before spawn loop when `mode === 'refactor-wave'`.

Also validates prefix overlaps (e.g., `src/auth/` contains `src/auth/login/`):
```typescript
// Check prefix containment
for (const [p1, c1] of allPaths) {
  for (const [p2, c2] of allPaths) {
    if (c1 !== c2 && (p1.startsWith(p2) || p2.startsWith(p1))) {
      throw new CliError(
        `Nested partition overlap: "${p1}" (${c1}) and "${p2}" (${c2})`,
        { kind: 'invalid_input' });
    }
  }
}
```

~40 LOC. Tests in task 2.8.

### Task 2.7 — Clone spawner peer scope for refactor-wave

**Package:** `@manta/cli`  
**File:** `packages/manta-cli/src/spawner/clone-spawner.ts`

Refactor-wave needs `MANTA_BUS_PEER_SCOPE: 'siblings-allowed'` for cross-module type reading but `peer_messaging: 'denied'` in policy. Current logic (line 153–155):

```typescript
MANTA_BUS_PEER_SCOPE: castMode === 'forking-realities' ? 'parent-only' : 'siblings-allowed'
```

Refactor-wave falls into `else` → `'siblings-allowed'`. **No code change needed.** Verify in tests.

### Task 2.8 — Unit tests for refactor-wave cast dispatch

**Package:** `@manta/cli`  
**File:** `packages/manta-cli/tests/commands/cast.test.ts` (extend)

New `describe('cast command — refactor-wave mode')`:
- `accepts refactor-wave as valid mode`
- `requires cloneAssignments (rejects without --tasks)`
- `rejects overlapping partitions`
- `rejects prefix-nested partitions`
- `sets peer_messaging = denied`
- `triggers merge-all after cast (not merge-review)`

~80 LOC.

### Task 2.9 — Unit tests for refactor-wave priming + merge-all

**Package:** `@manta/cli` + `@manta/orchestrator`  
**Files:**
- `packages/manta-cli/tests/spawner/priming.test.ts` (extend)
- `packages/manta-orchestrator/tests/merge-all.test.ts` (new)

Priming tests:
- `includes MODULE_BOUNDARY_BLOCK for refactor-wave`
- `does not include SELF_CERTAINTY_BLOCK for refactor-wave`

Merge-all tests:
- `merges all clone branches sequentially`
- `skips clone that fails quality gate`
- `handles merge conflict (escalates, continues with others)`
- `returns all_merged when all succeed`
- `returns partial_merge when some fail gate`
- `returns no_merges when all fail gate`
- `returns conflict_escalation when conflict detected`
- `writes merge-all report markdown`

~200 LOC.

### Task 2.10 — Integration test for refactor-wave lifecycle

**Package:** `@manta/cli`  
**File:** `packages/manta-cli/tests/integration/refactor-wave-spawn.test.ts` (new)

Full lifecycle with fake runner:
- Spawns 2 clones with disjoint module assignments
- Manifest mode = 'refactor-wave', peer_messaging = 'denied'
- Each clone scope has forbiddenPaths = other clone's allowedPaths
- cloneAssignments carry module list per clone
- merge_all event emitted (not merge_review)
- Settlement: charge credit for success

~150 LOC.

### Task 2.11 — E2E smoke test for refactor-wave

**Package:** `@manta/e2e`  
**File:** `packages/manta-e2e/tests/refactor-wave.e2e.test.ts` (new)

Pattern: follow `forking-realities.e2e.test.ts` structure.
- 2-clone refactor-wave with fake runner + disjoint partitions
- Assert: both clones DEAD, post-mortems exist
- Assert: merge-all report exists (not merge-review)
- Assert: forensic timeline exists, charge system recorded cost=2

~200 LOC.

### Task 2.12 — User docs for refactor-wave

**Package:** docs  
**File:** `docs/user/refactor-wave.md` (new)

Sections: When to use | How it works | Module partitioning | Tasks file format | CLI examples | Tips

~80 LOC.

### Clone Assignment Strategy (Chunk 2)

**Clone A** — Orchestrator layer (tasks 2.1, 2.2, 2.3, 2.9-merge-all-tests):
- merge-all.ts orchestrator (Clone A owns this shared prereq)
- merge-all-writer.ts report renderer
- Orchestrator exports
- merge-all unit tests

**Clone B** — CLI layer (tasks 2.4, 2.5, 2.6, 2.7, 2.8, 2.9-priming-tests, 2.10, 2.11, 2.12):
- cast.ts mode dispatch + refactor-wave wiring
- Priming block
- Partition validator
- Spawner verification
- All CLI-level unit and integration tests
- E2E test
- User docs

**Shared prereq:** `merge-all.ts` types + `runMergeAll` function → Clone A only. Clone B writes cast.ts wiring against the interface from this plan. At merge time, imports resolve.

**Note for Clone B:** The `runMergeAll` function and types are created by Clone A in `@manta/orchestrator`. Your `cast.ts` post-loop wiring should import `{ runMergeAll, MergeAllWriter }` from `@manta/orchestrator`. In your worktree, this import won't resolve until merge — write your code against the interface specified in this plan (task 2.1). Your integration tests can mock `runMergeAll` via the injected seam.

---

## Execution Plan

1. **Commit this plan** + reviewer approval
2. **Chunk 1 cast:** `manta cast forking-realities --clones 2 --tasks docs/research/phase-4-chunk1-tasks.yaml`
3. **Post-cast ceremony:** merge-review → code-review subagent → merge → build+test → post-mortem
4. **Chunk 2 cast:** `manta cast forking-realities --clones 2 --tasks docs/research/phase-4-chunk2-tasks.yaml`
5. **Post-cast ceremony:** same as above
6. **Final sweep:** full workspace test, build, lint → commit docs + INDEX update

## Success Criteria

- `SUPPORTED_MODES` contains all 4 Wave-1 modes: `recon-swarm`, `forking-realities`, `bug-hunt`, `refactor-wave`
- `manta cast bug-hunt --clones 2 --task "..."` works end-to-end
- `manta cast refactor-wave --clones 2 --tasks partition.yaml` works end-to-end
- read_broadcasts MCP tool functional (clones can read sibling broadcasts)
- merge-all orchestrator merges all clone branches with quality gates
- Charge system correctly handles both modes (cost=2 each)
- All tests green, build+lint clean
- Test coverage ≥ 80% on new code
- User docs for both modes

## Open Questions (Decided)

1. **Investigation reports structured vs freeform?** → Freeform markdown with required sections in priming (soft guidance, not enforcement per pitfalls.md)
2. **read_broadcasts filter by cast_id?** → Yes, clones see only own cast broadcasts
3. **bug-hunt >2 clones?** → Enforce 1–2 in cast.ts, no override flag (spec is clear)
4. **Merge commit author for merge-all?** → Operator identity (consistent with manual merge)
5. **Merge-all atomic or incremental?** → Incremental (partial_merge better than no merge)
6. **Auto-partition for refactor-wave?** → Defer to Phase 4b, tasks-file is the primary path for Phase 4
