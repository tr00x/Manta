# Phase 4: refactor-wave Mode Design

> Clone B research deliverable, cast-1779890518943  
> Date: 2026-05-27

## 1. Executive Summary

`refactor-wave` is a Wave-1 batch-spawn mode (Spec Sec 2, line 60) where N clones simultaneously apply the same migration pattern to different modules in a parallel sweep. Unlike `forking-realities` (best-of-N competing approaches), refactor-wave clones are **complementary** — each handles a disjoint slice of the codebase, and ALL outputs merge into main.

Key design differences from existing modes:
- **Merge-all** instead of pick-winner
- **Module partitioning** instead of identical task
- **Scope isolation by partition** instead of full-repo access
- **No scoring/ranking** — quality gate per clone, not relative comparison

Charge cost: 2 (same as forking-realities, Spec Sec 6.4 line 280).

---

## 2. Existing Infrastructure Analysis

### 2.1 Mode Dispatch Points

Every mode-aware branch in the codebase that needs a `refactor-wave` case:

| File | Line | Current Logic | refactor-wave Needs |
|------|------|---------------|---------------------|
| `cast.ts` | 29-32 | `SUPPORTED_MODES` set — only `recon-swarm`, `forking-realities` | Add `'refactor-wave'` to the set |
| `cast.ts` | 248-251 | `CastPolicy` — forking: denied peer messaging; else: allowed | refactor-wave: `peer_messaging: 'allowed'` (clones may need to coordinate on shared boundary files) |
| `cast.ts` | 427-468 | Merge-review triggered only for `forking-realities` | refactor-wave: **skip merge-review scoring** — trigger merge-all flow instead |
| `priming.ts` | 30-34 | `SELF_CERTAINTY_BLOCK` injected only for forking-realities | refactor-wave: no self-certainty (not competing) — inject `MODULE_BOUNDARY_BLOCK` instead |
| `clone-spawner.ts` | 154-156 | `MANTA_BUS_PEER_SCOPE`: forking='parent-only', else='siblings-allowed' | refactor-wave: `'siblings-allowed'` (boundary coordination) |
| `forking-isolation.ts` | 15-16 | Cross-clone read blocked only for `forking-realities` | refactor-wave: reads **allowed** (clones need to read sibling modules for context) |
| `auto-downgrade.ts` | 22 | `'refactor-wave': 'recon-swarm'` downgrade path | Already mapped — no change needed |
| `budget-config.ts` | 34 | `'refactor-wave': 3.00` cost estimate | Already mapped — no change needed |
| `schema.ts` (bus) | 15, 280 | Mode in enum; cost = 2 | Already present — no change needed |
| `schema.ts` (snapshot) | 10 | Mode in enum | Already present — no change needed |

### 2.2 Reusable Infrastructure

These components work as-is for refactor-wave:

- **Worktree management** (`worktree.ts`) — mode-agnostic, creates isolated worktrees per clone
- **Snapshot building** (`buildCloneSnapshot`) — carries mode + task + scope
- **Task contract** (`TaskContractSchema`) — already supports per-clone scope with `forbidden_paths`
- **Clone spawner** (`clone-spawner.ts`) — mode-agnostic process lifecycle
- **Charge system** — `MODE_CHARGE_COST['refactor-wave'] = 2` already exists
- **Outcome classifier** (`cast-outcome.ts`) — mode-agnostic (checks death reasons, not mode)
- **Bus coordination** — lock/unlock, broadcast, claim_work all mode-agnostic
- **Tasks file parser** (`tasks-file.ts`) — already parses per-clone `CloneAssignment` with scope

### 2.3 New Infrastructure Needed

| Component | Scope | Rationale |
|-----------|-------|-----------|
| `merge-all.ts` | New file in `manta-orchestrator` | Sequential merge of all clone branches (complement to `merge-review.ts`) |
| Per-clone quality gate | New function in `scoring.ts` or `merge-all.ts` | Individual pass/fail per clone (not relative ranking) |
| Module partition validator | New function in `cast.ts` | Verify partitions are disjoint before spawning |
| refactor-wave priming block | Addition to `priming.ts` | Module boundary awareness text |
| CLI partition UX | Addition to `manta.ts` | `--partition` flag or tasks-file based |

---

## 3. Design Decisions

### 3.1 Worktree Model

**Recommendation: Isolated worktrees per clone (same as forking-realities)**

| Approach | Pros | Cons |
|----------|------|------|
| **Isolated worktrees** (recommended) | No write conflicts; parallel git operations safe; existing infra works as-is | Merge step needed at end |
| Shared worktree with file locks | Simpler merge; real-time coordination | Git operations unsafe in parallel; bus lock contention; single git index = serialized commits |

Rationale: Isolated worktrees are the proven model from forking-realities. The merge step is straightforward because partitions are disjoint by design — no conflict resolution needed for well-specified partitions.

**Key difference from forking-realities:** clones CAN read sibling worktrees (via `forking-isolation.ts` — only forking-realities blocks cross-clone reads). This lets a clone read imported types from a module assigned to a sibling, which is critical for refactors that change shared interfaces.

### 3.2 Module Partitioning

**Recommendation: Explicit assignment via tasks file (primary) + auto-partition helper (convenience)**

#### 3.2.1 Explicit Assignment (Primary Path)

The existing `--tasks` YAML file already supports per-clone `CloneAssignment` with `scope.allowed_paths` and `scope.forbidden_paths`. This is the natural fit:

```yaml
# refactor-wave-tasks.yaml
A:
  task: "Migrate all Logger.info() calls to structured logging format"
  scope:
    allowed_paths: ["packages/manta-cli/"]
    forbidden_paths: ["packages/manta-bus/", "packages/manta-orchestrator/", "packages/manta-snapshot/"]
    max_files_changed: 50
B:
  task: "Migrate all Logger.info() calls to structured logging format"
  scope:
    allowed_paths: ["packages/manta-bus/"]
    forbidden_paths: ["packages/manta-cli/", "packages/manta-orchestrator/", "packages/manta-snapshot/"]
    max_files_changed: 50
C:
  task: "Migrate all Logger.info() calls to structured logging format"
  scope:
    allowed_paths: ["packages/manta-orchestrator/", "packages/manta-snapshot/"]
    forbidden_paths: ["packages/manta-cli/", "packages/manta-bus/"]
    max_files_changed: 50
```

**Validation rule (new):** For refactor-wave, the orchestrator MUST verify that `allowed_paths` across clones are **pairwise disjoint**. Overlap in allowed_paths is a hard error — the user must resolve ambiguity before casting.

#### 3.2.2 Auto-Partition Helper (Convenience)

For simple directory-based migrations, offer `--auto-partition` that discovers top-level modules and distributes them round-robin:

```bash
manta cast refactor-wave --task "Migrate Logger" --auto-partition packages/ --clones 3
```

Implementation: scan `packages/` for subdirectories → assign `ceil(N/cloneCount)` per clone → generate the tasks YAML internally. This is syntactic sugar; under the hood it produces the same `CloneAssignment` records.

**Deferral recommendation:** implement `--auto-partition` in Phase 4b or later. The tasks-file path covers all use cases; auto-partition is a UX convenience.

### 3.3 Task Contract Structure

Each clone receives:

```typescript
interface RefactorWaveContract {
  // Standard fields (existing TaskContract)
  clone_id: string;
  mode: 'refactor-wave';
  task: string;          // Migration pattern description (same for all clones)
  scope: {
    allowed_paths: string[];    // This clone's assigned modules
    forbidden_paths: string[];  // All OTHER clones' modules
    max_files_changed: number;
  };
  sibling_clones: string[];
  deadline_ms: number;

  // Refactor-wave specific (new fields, optional on TaskContract)
  migration_pattern?: string;  // Detailed pattern description for consistency
  example_before?: string;     // Before-code example
  example_after?: string;      // After-code example
}
```

**Design decision on new fields:** The `migration_pattern`, `example_before`, `example_after` fields are high-value for ensuring consistency across clones. However, extending `TaskContractSchema` requires schema changes in `@manta/bus`.

**Recommendation: Use `approach_hint` for migration details in Phase 4.** The existing `approach_hint` field (string, max 8000 chars) is more than sufficient to carry migration pattern + examples. Adding typed fields can wait for Phase 5+ when we have daemon-mode and richer contracts.

```yaml
A:
  task: "Migrate Logger.info() to structured format"
  approach_hint: |
    Pattern: Replace Logger.info('message', data) with Logger.info({ msg: 'message', ...data })
    Before: Logger.info('cast started', { castId })
    After:  Logger.info({ msg: 'cast started', castId })
    Apply to ALL .ts files in your assigned modules.
  scope:
    allowed_paths: ["packages/manta-cli/"]
    forbidden_paths: ["packages/manta-bus/"]
    max_files_changed: 50
```

### 3.4 File-Lock Coordination

**Recommendation: Scope enforcement is sufficient; bus locks NOT needed for refactor-wave**

| Approach | Pros | Cons |
|----------|------|------|
| **Scope-only** (recommended) | Zero overhead; disjoint partitions guarantee no overlap by construction; simpler mental model | No runtime guard if scope misconfigured |
| Bus file locks | Runtime protection against cross-module edits | Adds lock contention overhead; partitions already prevent overlap; locks designed for shared-worktree scenario (test-storm, pair-programming) |

Rationale: refactor-wave uses disjoint partitions enforced at spawn time. If clone A's `allowed_paths` is `["packages/manta-cli/"]` and clone B's is `["packages/manta-bus/"]`, they cannot write to each other's files because the scope constraint is validated before spawning and embedded in the task contract. The clone's priming text already says "stay inside taskContract.scope.allowedPaths and outside taskContract.scope.forbiddenPaths."

The bus lock system (`manta.lock`/`manta.unlock`) is designed for fine-grained file-level coordination in shared-worktree modes (Phase 5+: test-storm, pair-programming). Using it for refactor-wave would add unnecessary complexity.

**Edge case — shared files:** Some files (e.g., `index.ts` barrel exports, shared types) may need changes from multiple clones. Solution: assign shared files to ONE designated clone (typically clone A) in the tasks file. Other clones' approach_hint should note: "Shared types in `packages/shared/` are handled by Clone A. Code against the current interface; the merge will include A's updates."

### 3.5 Merge Strategy

**Recommendation: Sequential merge-all with per-clone quality gate**

This is the core differentiator from forking-realities. Instead of picking a winner, refactor-wave merges ALL clone branches.

#### 3.5.1 Merge Flow

```
main ←── clone-A branch ←── clone-B branch ←── clone-C branch
          (merge #1)          (merge #2)          (merge #3)
              ↓                    ↓                    ↓
         quality gate         quality gate         quality gate
```

1. **Order clones by exit time** (first finished → first merged). This minimizes the chance of conflicts because earlier merges have a smaller diff.

2. **Per-clone quality gate** (before each merge):
   - `tsc --noEmit` on the clone's worktree — must pass
   - `eslint` on changed files — 0 errors (warnings allowed)
   - Clone's own test files pass (if any were modified)
   - If gate fails → **skip this clone's merge**, log to merge-all report, continue with others

3. **Sequential merge** (not parallel):
   ```bash
   git checkout main
   git merge manta/<castId>/A --no-ff -m "manta-refactor-wave: merge clone A"
   # run quality gate on merged state
   git merge manta/<castId>/B --no-ff -m "manta-refactor-wave: merge clone B"
   # run quality gate on merged state
   # ...
   ```

4. **Conflict handling:**
   - If partitions are truly disjoint → **zero conflicts expected**
   - If a conflict occurs → **escalate to operator** (do NOT auto-resolve). A conflict in refactor-wave means the partitioning was wrong, which is a bug in the task specification, not something to patch over.
   - Log the conflicting files + clone pair in the merge-all report.

5. **Post-merge full test suite** run after all branches are merged.

#### 3.5.2 Merge-All Report Format

```markdown
# Merge-All Report: cast-<id>

## Summary
- Mode: refactor-wave
- Clones: 3 (A, B, C)
- Merged: 2 (A, B)
- Skipped: 1 (C — quality gate: 3 tsc errors)
- Conflicts: 0

## Per-Clone Results
| Clone | Module | Files Changed | Quality Gate | Merge Status |
|-------|--------|---------------|-------------|--------------|
| A | packages/manta-cli/ | 12 | PASS | Merged |
| B | packages/manta-bus/ | 8 | PASS | Merged |
| C | packages/manta-orchestrator/ | 5 | FAIL (tsc: 3 errors) | Skipped |

## Quality Gate Details
### Clone C — FAILED
- tsc errors: 3
  - src/merge-review.ts:45 — TS2345: Argument of type 'string' is not assignable...
  - ...

## Post-Merge Test Suite
- Total: 142 | Pass: 140 | Fail: 2
- Failing tests likely related to Clone C's skipped module (manual investigation needed)
```

#### 3.5.3 Comparison: merge-review vs merge-all

| Aspect | forking-realities (merge-review) | refactor-wave (merge-all) |
|--------|----------------------------------|---------------------------|
| Goal | Pick best approach | Merge all contributions |
| Scoring | Relative ranking (composite score) | Individual pass/fail gate |
| Verdict | auto_merge / manual_review / no_candidates / dominance_inversion | all_merged / partial_merge / no_merges / conflict_escalation |
| Tie-breaking | axis_priority → pareto → self_certainty → defer | N/A |
| Self-certainty signal | Yes (forking priming block) | No |
| Output | Winner clone + scores | Merged main + per-clone status |
| Conflict handling | N/A (only one branch merges) | Escalate to operator |

### 3.6 Post-Cast Validation

After merge-all completes:

1. **Full test suite** (`npm test` / `vitest run` at repo root)
2. **Type check** (`tsc --noEmit` at repo root)
3. **Lint** (`eslint` on all changed files across all merged branches)
4. **Diff summary** — total lines changed, files modified, per-module breakdown

If post-merge validation fails, the merge-all report includes the failures and recommends manual investigation. The operator can:
- Fix manually and commit
- Revert the merge sequence (`git reset --hard` to pre-merge HEAD)
- Re-cast with updated task contracts

### 3.7 Mode-Specific Priming Text

New block for `priming.ts` (replaces `SELF_CERTAINTY_BLOCK` for refactor-wave):

```typescript
const MODULE_BOUNDARY_BLOCK = `
## Module Boundary Rules (refactor-wave)

You are one of N clones applying the same migration pattern to different modules.
Your assigned modules are in taskContract.scope.allowedPaths.
Other clones handle the modules in taskContract.scope.forbiddenPaths.

Critical rules:
1. ONLY modify files within your assigned modules (allowedPaths).
2. You MAY read files in other modules for context (imports, types, interfaces).
3. If you discover that the migration pattern doesn't apply cleanly to your module, 
   broadcast a finding via manta.broadcast with event_type 'pattern_exception'.
4. If you need a type/interface change in another module, broadcast it via 
   manta.broadcast with event_type 'cross_module_request' — do NOT make the change yourself.
5. Commit atomically per logical unit (one file or one function migration per commit).
6. Your branch will be merged with all sibling branches — ensure your code compiles 
   against the CURRENT interface of sibling modules (not a speculative future state).
`;
```

### 3.8 CLI UX

#### 3.8.1 Command Syntax

```bash
# Primary: explicit tasks file
manta cast refactor-wave \
  --task "Migrate Logger.info() to structured format" \
  --tasks refactor-tasks.yaml \
  --clones 3

# Convenience: auto-partition (Phase 4b+)
manta cast refactor-wave \
  --task "Migrate Logger.info() to structured format" \
  --auto-partition packages/ \
  --clones 3
```

#### 3.8.2 New CLI Flag

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--auto-partition` | `string` (dir path) | none | Auto-discover modules in directory and distribute to clones |

**No new required flags.** The existing `--tasks` flag handles the primary path. `--auto-partition` is a convenience flag for Phase 4b+.

#### 3.8.3 Pre-Spawn Validation (refactor-wave specific)

Before spawning clones, `cast.ts` adds these checks for `mode === 'refactor-wave'`:

1. **Tasks file required** — refactor-wave without per-clone assignments is an error. Each clone MUST have explicit `scope.allowed_paths`.
2. **Disjoint partition check** — for all clone pairs (i, j), `allowed_paths[i] ∩ allowed_paths[j] = ∅`.
3. **Full coverage warning** (non-blocking) — if the union of all `allowed_paths` doesn't cover the likely affected area, warn but don't block.

---

## 4. Implementation Plan

### 4.1 Task Breakdown

| # | Task | Package | Depends On | Estimated LOC |
|---|------|---------|------------|---------------|
| 4.1 | Add `'refactor-wave'` to `SUPPORTED_MODES` | manta-cli | — | ~5 |
| 4.2 | Add mode-specific policy branch for refactor-wave | manta-cli (cast.ts) | 4.1 | ~10 |
| 4.3 | Add disjoint partition validator | manta-cli (cast.ts) | 4.1 | ~40 |
| 4.4 | Add MODULE_BOUNDARY_BLOCK to priming.ts | manta-cli (priming.ts) | 4.1 | ~25 |
| 4.5 | Create merge-all.ts orchestrator | manta-orchestrator | — | ~200 |
| 4.6 | Add per-clone quality gate | manta-orchestrator | 4.5 | ~80 |
| 4.7 | Wire merge-all into cast.ts post-loop | manta-cli (cast.ts) | 4.5, 4.6 | ~40 |
| 4.8 | Add merge-all report renderer | manta-orchestrator | 4.5 | ~60 |
| 4.9 | Outcome classifier awareness | manta-cli (cast-outcome.ts) | — | ~0 (no change needed) |
| 4.10 | Unit tests for partition validator | manta-cli | 4.3 | ~60 |
| 4.11 | Unit tests for merge-all | manta-orchestrator | 4.5, 4.6 | ~120 |
| 4.12 | Integration test for full refactor-wave lifecycle | manta-e2e | 4.1-4.8 | ~150 |
| 4.13 | Update operator docs | docs/ | 4.1-4.8 | ~80 |

**Total estimated: ~870 LOC** (implementation + tests + docs)

### 4.2 Recommended Cast Strategy

Split into 2 implementation chunks:

**Chunk 1 (forking-realities cast, 2 clones):**
- Clone A: Tasks 4.1-4.4 (cast.ts mode dispatch + priming + partition validator)
- Clone B: Tasks 4.5-4.6, 4.8 (merge-all orchestrator + quality gate + report)

**Chunk 2 (forking-realities cast, 2 clones):**
- Clone A: Tasks 4.7, 4.10, 4.11 (wiring + unit tests)
- Clone B: Tasks 4.12, 4.13 (e2e test + docs)

Note: Use forking-realities for implementation (competing approaches to the same deliverable), not refactor-wave (we're building refactor-wave, can't use it to build itself yet).

---

## 5. Merge-All Algorithm Detail

### 5.1 Pseudocode

```typescript
interface MergeAllResult {
  verdict: 'all_merged' | 'partial_merge' | 'no_merges' | 'conflict_escalation';
  merged: string[];      // clone IDs successfully merged
  skipped: string[];     // clone IDs that failed quality gate
  conflicted: string[];  // clone IDs that caused merge conflicts
  postMergeTestsPassed: boolean;
}

async function runMergeAll(ctx: BusContext, opts: MergeAllOptions): Promise<MergeAllResult> {
  const clones = sortByExitTime(opts.deadClones);
  const merged: string[] = [];
  const skipped: string[] = [];
  const conflicted: string[] = [];

  for (const clone of clones) {
    // 1. Quality gate on clone's worktree
    const gate = await runQualityGate(clone.worktreePath);
    if (!gate.passed) {
      skipped.push(clone.id);
      continue;
    }

    // 2. Attempt merge
    const branch = `manta/${opts.castId}/${clone.id}`;
    const mergeResult = await gitMerge(opts.repoRoot, branch);
    
    if (mergeResult.hasConflicts) {
      await gitMergeAbort(opts.repoRoot);
      conflicted.push(clone.id);
      continue;
    }

    merged.push(clone.id);
  }

  // 3. Post-merge validation
  const postMerge = merged.length > 0 
    ? await runPostMergeValidation(opts.repoRoot)
    : { passed: false };

  // 4. Determine verdict
  let verdict: MergeAllResult['verdict'];
  if (conflicted.length > 0) verdict = 'conflict_escalation';
  else if (merged.length === clones.length) verdict = 'all_merged';
  else if (merged.length > 0) verdict = 'partial_merge';
  else verdict = 'no_merges';

  return { verdict, merged, skipped, conflicted, postMergeTestsPassed: postMerge.passed };
}
```

### 5.2 Quality Gate Axes

| Axis | Check | Fail = Skip |
|------|-------|-------------|
| TypeScript compilation | `tsc --noEmit` in worktree | Yes |
| Lint errors | `eslint` on changed files, 0 errors | Yes |
| Tests pass | `vitest run` in worktree | Yes |
| Non-empty diff | `git diff main..branch` has changes | No (empty diff = no-op merge, skip silently) |

### 5.3 Event Bus Integration

New event types for merge-all (appended to `events.jsonl`):

```typescript
// Quality gate result per clone
{ type: 'merge_all_gate', clone_id: 'A', payload: { passed: true, tsc: 0, eslint: 0, tests: 42 } }

// Merge attempt result per clone
{ type: 'merge_all_step', clone_id: 'A', payload: { status: 'merged', files_changed: 12 } }
{ type: 'merge_all_step', clone_id: 'C', payload: { status: 'skipped', reason: 'quality_gate', tsc_errors: 3 } }

// Final verdict
{ type: 'merge_all_complete', payload: { verdict: 'partial_merge', merged: ['A','B'], skipped: ['C'] } }
```

---

## 6. Comparison with forking-realities Implementation

| Dimension | forking-realities | refactor-wave |
|-----------|-------------------|---------------|
| **SUPPORTED_MODES** | In set | Must add |
| **CastPolicy** | `peer_messaging: 'denied'` | `peer_messaging: 'allowed'` |
| **MANTA_BUS_PEER_SCOPE** | `'parent-only'` | `'siblings-allowed'` |
| **Cross-clone reads** | Blocked (`forking-isolation.ts`) | Allowed |
| **cloneAssignments** | Optional (same task) | **Required** (disjoint modules) |
| **Pre-spawn validation** | Standard | + Disjoint partition check |
| **Post-loop flow** | `runMergeReview()` → pick winner | `runMergeAll()` → merge all |
| **Scoring** | Relative ranking (5 axes + tie-break) | Per-clone pass/fail gate |
| **Self-certainty** | Yes (priming block) | No |
| **Priming block** | SELF_CERTAINTY_BLOCK | MODULE_BOUNDARY_BLOCK |
| **Conflict handling** | N/A | Escalate to operator |
| **Report** | `merge-reviews/cast-<id>.md` | `merge-all-reports/cast-<id>.md` |
| **Outcome classifier** | Same logic | Same logic (no mode branch needed) |
| **Charge cost** | 2 | 2 |

---

## 7. Edge Cases and Risk Mitigations

### 7.1 Non-Disjoint Partitions

**Risk:** User specifies overlapping `allowed_paths`.  
**Mitigation:** Pre-spawn validator rejects overlapping partitions with clear error message listing the overlap.

### 7.2 Shared Interface Changes

**Risk:** Module A exports a function signature that Module B imports. Clone A changes the signature; Clone B compiles against the old signature.  
**Mitigation:**
1. Priming text instructs clones to code against CURRENT interfaces
2. Post-merge type check catches incompatibilities
3. Operator guidance: assign shared modules (types, interfaces) to a single clone

### 7.3 One Clone Fails Quality Gate

**Risk:** Clone C fails tsc, its module isn't migrated.  
**Mitigation:** Merge-all continues with passing clones. Report clearly identifies the gap. Operator can re-cast with a single clone targeting the failed module.

### 7.4 Clone Produces Empty Diff

**Risk:** Clone finishes but the migration pattern didn't apply to its module.  
**Mitigation:** Silently skip (no-op merge). Report notes "0 files changed."

### 7.5 Merge Conflict Despite Disjoint Partitions

**Risk:** Two clones modify the same auto-generated file (e.g., `package-lock.json`, barrel exports).  
**Mitigation:**
1. Add common auto-generated files to ALL clones' `forbidden_paths` by default
2. If conflict occurs, abort that merge step, continue with remaining clones, escalate to operator

### 7.6 Clone Dies Before Completing

**Risk:** Clone B times out with partial work.  
**Mitigation:** Outcome classifier handles this (existing logic). Merge-all runs quality gate on whatever the clone committed. Partial work that passes gate gets merged; partial work that fails gate gets skipped.

---

## 8. Open Questions for Implementation Phase

1. **Merge commit author** — should merge-all commits use the operator's git identity or a Manta service identity? Recommend: operator identity (consistent with current forking-realities manual merge).

2. **Atomic merge-all** — should the entire merge sequence be atomic (all-or-nothing) or incremental (merge what passes)? Recommend: incremental (partial_merge is better than no merge).

3. **Auto-partition heuristics** — when implementing `--auto-partition`, should it respect `.gitignore` patterns? Consider monorepo tools like Turborepo/Nx workspace detection? Defer to Phase 4b.

4. **Broadcast protocol for cross-module requests** — define the exact schema for `pattern_exception` and `cross_module_request` broadcast payloads. Can be designed during implementation.
