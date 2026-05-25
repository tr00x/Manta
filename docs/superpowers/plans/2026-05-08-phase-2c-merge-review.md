# Phase 2c — Merge-Review (Best-of-N Scoring + Promote) Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Production-grade merge-review for `forking-realities` casts. After this plan ships, every completed forking-realities cast produces a scored `merge-review.md` ranking all candidates by a composite weighted metric, and the main agent can `/manta promote <castId>/<cloneId>` to merge the winner's worktree branch. Auto-merge is disabled in Phase 2 (`autoMergeThreshold = Infinity`); the operator always makes the final call. Bug #14 (audit double-fire on idempotent `CastsStore.create`) is fixed as a prerequisite.

**Architecture:** Two chunks. Chunk 1 lands the **scoring engine + merge-review orchestrator module** in `@manta/orchestrator` — pure logic (no shell-outs), fully unit-testable: `ScoringConfig` schema + `.manta/config/scoring.json` loader, metric normalization, composite weighted score, deterministic tie-breaking (axis priority → Pareto dominance → self-certainty → defer to main), `assertNoDominationInversion` safety check, `findFinalisedCasts` query, `runMergeReview` orchestrator function, `MergeReviewWriter` interface, markdown renderer. Bug #14 fix in `@manta/bus` `atomicMutateJson`. Chunk 2 lands the **CLI wiring** — real `MetricCollector` (shells out to `pnpm test`, `tsc`, `eslint`, reads coverage, computes diff/complexity), `cast.ts` post-loop merge-review trigger for forking-realities, `/manta promote <id>` command, `moveWorktreeToGraveyard` helper, `manta-merge-review` skill, agentic rubric pre-pass (reads project config to adjust weights per-cast), self-certainty priming addition, cross-candidate ZK harvest, integration test, docs.

**Tech Stack:** TypeScript 5.x strict, Node 20+, `zod`, `vitest`. Zero new runtime dependencies — metric collection shells out to project-local tools (`pnpm`, `tsc`, `eslint`) via `execa` (already a dependency). Scoring math is dependency-free.

---

## Why two chunks (and not one, and not three)

The scoring engine (Chunk 1) and the CLI metric collection + wiring (Chunk 2) have a clean dependency boundary: Chunk 2 calls Chunk 1's `runMergeReview` with pre-collected metrics. Splitting them lets Chunk 1 be reviewed and tested in isolation — all its tests are pure math, no filesystem, no subprocesses.

Splitting further (3+ chunks) would fragment the CLI wiring across multiple commits without meaningful review-isolation benefit — the promote command, graveyard helper, metric collector, and cast.ts integration are all tightly coupled (they form one user-visible flow: "cast ends → metrics collected → review rendered → operator promotes → loser worktrees graveyard'd").

---

## Scope

In-scope (Phase 2c):

- **Bug #14 fix** — `atomicMutateJson` skips `auditAppend` when mutator returns reference-identical `current` (idempotent no-op path). Fixes latent audit-double-fire in `CastsStore.create`.
- **`ScoringConfig` schema + defaults** — weights in `.manta/config/scoring.json` (coverage 0.30 / diff 0.20 / complexity 0.20 / type 0.15 / lint 0.15 + perf bonus 0.10). Loaded at merge-review time; missing file → defaults.
- **`MetricCollector` interface** (DI seam) — orchestrator defines the contract, CLI provides the real implementation. Enables unit-testing scoring without subprocesses.
- **Metric normalization** — raw metrics → `[0, 1]` per-cohort; `1.0` = best of cohort.
- **Composite weighted scoring** — `score = Σ wᵢ · normalize(metricᵢ)`.
- **Hard test gate** — candidates whose test suite fails are disqualified, not down-ranked.
- **Tie-breaking chain** — axis priority (coverage → complexity → diff → lint → type → perf) → Pareto dominance → self-certainty (if broadcast present) → defer to main. No first-finish bias, no random by default. `ε = 0.05` noise band.
- **`assertNoDominationInversion`** — if the top-ranked candidate is Pareto-dominated by another, emit `ranking_anomaly` event and force manual review.
- **`findFinalisedCasts`** — reads `CastsStore.list()` + `Registry.list()` + `EventsLog`, returns casts with all clones DEAD and no `merge_review` event.
- **`runMergeReview`** — orchestrator function taking pre-collected `CandidateMetrics[]` + `ScoringConfig`, emitting scored ranking, merge-review markdown, and `merge_review` event.
- **`MergeReviewWriter`** interface — parallel to `PostMortemWriter`; `fsMergeReviewWriter` writes to `docs/merge-reviews/<castId>.md`.
- **Real `MetricCollector`** in CLI — shells out per worktree: `pnpm -r test` (exit code gate), coverage via `vitest --coverage` JSON output, `tsc --noEmit` error count, `eslint .` warning/error counts, `git diff --stat` line count, cyclomatic complexity via simple AST walk of changed files.
- **`cast.ts` post-loop merge-review** — after tick loop exits for forking-realities, collect metrics + call `runMergeReview`.
- **`/manta promote <castId>/<cloneId>`** — merge the winner's worktree branch into the current branch, move losers to graveyard.
- **`moveWorktreeToGraveyard`** — renames worktree from `.manta/worktrees/clone-X` to `.manta/graveyard/<castId>-<cloneId>/` with `info.json` sidecar.
- **Agentic rubric pre-pass** — before scoring, read `tsconfig.json`, `.eslintrc.*`, `vitest.config.ts` from the repo root; adjust scoring weights per-cast. Audit every adjustment to Tier 4 events log.
- **Self-certainty tie-breaker** — priming addition: clones broadcast `{ type: 'self_certainty', score: 1-10 }` before death. Merge-review reads it from events log as tertiary tie-breaker within ε band.
- **Cross-candidate ZK harvest** — after ranking, read all candidate diffs, emit 1-3 convergence-filtered cross-candidate ZK notes tagged `cast-<castId> loser-insights`.
- **`manta-merge-review` skill** — main-side skill describing the merge-review output format and how to use `/manta promote`.
- **`/manta promote` slash command** — `commands/manta-promote.md`.
- **Docs** — update `docs/user/forking-realities.md` (merge-review section), new `docs/internals/merge-review-scoring.md` (weight rationale + agentic rubric), update `CHANGELOG.md`.

Out of scope (deferred):

- **Auto-merge** — threshold set to `Infinity` in Phase 2. Code path shipped but never triggered. Phase 5+ tunes it based on telemetry.
- **`--break-ties-randomly` flag** — CI / unattended scenarios. Phase 5+ when daemon mode lands.
- **Symbolic equivalence partitioning** (arxiv 2604.06485) — needs synthesised test inputs. Deferred indefinitely.
- **Graveyard retention reaper** — the 3-day retention timer (spec Sec 7) needs a `manta exhume` / auto-reap. Phase 4+ or Phase 7 `manta exhume` command.
- **Tier 3-4 observability commands** (`tail`, `replay`, `audit`, `inspect`) — Phase 2d.
- **Performance benchmark metric** — only kicks in when a benchmark exists. The `+0.10 bonus` slot is wired but the collector returns `null` when no benchmark is detected. Phase 3+ wires real perf collection.

---

## Spec & research alignment

| Spec / research anchor | Demand | This plan's response |
|---|---|---|
| Spec Sec 7 (Best-of-N / merge-review) | Composite scoring, winner pick, graveyard losers, harvest insights from all | Full merge-review flow: hard test gate → composite score → tie-break → merge-review.md → promote → graveyard. ZK harvest from losers. |
| Spec Sec 6.4 (Charge cost) | `forking-realities` Charge = 2 | Unchanged — merge-review is post-cast, no charge impact |
| Spec Sec 11.0 (Observability Tier 4) | Forensic audit trail per cast | Every component score, tie-break decision, weight adjustment, and merge verdict emitted as events to `events.jsonl` |
| Spec Sec 14 (Production quality) | No TODO/skip/mock in merged code | All quality gates enforced per CLAUDE.md |
| Research §3 (Composite weighted scoring) | Coverage 0.30 / Diff 0.20 / Complexity 0.20 / Type 0.15 / Lint 0.15 + Perf bonus 0.10 | Exact weights as v1 defaults in `.manta/config/scoring.json` |
| Research §4 (Hybrid auto-merge) | Ship code path, `autoMergeThreshold = Infinity` for Phase 2 | `autoMergeThreshold` in `CastPolicy` (already on manifest from Phase 2a). Merge-review checks it; Phase 2 always `manual_review_required`. |
| Research §5 (Tie-breaking) | ε=0.05, axis priority, no first-finish bias | Implemented exactly per research recommendation |
| Research §6 (Loser insights) | Both clone-death ZK (test-asserted) + merge-review cross-candidate harvest | Clone-death ZK already required (Phase 1 bug #5 fix). Cross-candidate harvest is new in Chunk 2. |
| Research addendum (Agentic rubric pre-pass) | Read project config, adjust weights per-cast | `adjustWeightsFromProject()` reads `tsconfig.json`, `.eslintrc.*`, `vitest.config.ts`. Audits adjustments. |
| Research addendum (Self-certainty) | Tertiary tie-breaker from clone's own confidence | Priming addition + events log reader + tie-break chain slot |
| ZK `static-rubric-is-stale-before-shipping` | Static weights are 2025 SOTA; agentic pre-pass is 2026 | Agentic rubric pre-pass implemented |
| ZK `self-certainty-as-tertiary-tiebreaker` | Cheap third tier between composite score and random | Self-certainty slot in tie-break chain |
| Bug #14 (audit double-fire) | `auditAppend` fires on idempotent no-op `CastsStore.create` | Fix in `atomicMutateJson`: reference-identity skip |

---

## Quality bar (CLAUDE.md / spec Sec 14)

- Test coverage ≥ 80% statements/branches on every new/modified file.
- TDD per task: failing test → run → minimal impl → re-run → commit.
- No `// TODO`, `// FIXME`, `it.skip`, `test.skip` in merged code.
- Atomic conventional commits, `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` in each.
- Ships with: docs committed atomically with the code; scoring rationale in `docs/internals/`.
- No lint warnings.
- Plan reviewer subagent must approve each chunk before it executes.

---

## Reference docs

- Source-of-truth design: `docs/superpowers/specs/2026-05-06-manta-pattern-design.md` — Sec 7 (best-of-N / merge-review), Sec 6.4 (Charge), Sec 11.0 (observability), Sec 14 (production quality).
- Predecessor plans: `2026-05-08-phase-2b-bus-isolation.md` (isolation boundaries — Phase 2c consumes cast_id-stamped broadcasts), `2026-05-08-phase-2a-forking-spawn.md` (cast manifest + `CastsStore` + `CastPolicy` — Phase 2c reads manifest for roster/policy).
- Phase 2 research: `docs/research/phase-2-best-of-n-patterns.md` (clone-B — scoring algorithm, tie-breaking, hybrid auto-merge, loser insights), `docs/research/phase-2-codepath-map.md` (clone-A — §5 merge-review hook points), `docs/research/phase-2-bus-isolation.md` (clone-C — tool surface table).
- ZK notes: `docs/zk/static-rubric-is-stale-before-shipping.md`, `docs/zk/self-certainty-as-tertiary-tiebreaker.md`.
- Project rules: `CLAUDE.md` — Quality bar (PROD only), Git rules.
- Pitfalls memo: `docs/internals/claude-code-pitfalls.md` — required read before any skill/priming edit.

---

## Chunks

1. **Chunk 1 — Scoring Engine + Merge-Review Orchestrator Module + Bug #14 Fix.** `@manta/bus` bug #14 fix (atomicMutateJson reference-identity skip). `@manta/orchestrator` new modules: `scoring.ts` (ScoringConfig schema + normalize + composite + tie-break + Pareto), `merge-review.ts` (findFinalisedCasts + runMergeReview + renderMarkdown), `merge-review-writer.ts` (MergeReviewWriter interface + fs + in-memory impls). Re-exports from `index.ts`. Full unit test suite.
2. **Chunk 2 — CLI Wiring + Metric Collectors + Promote + Graveyard + Skill + ZK Harvest.** Real `MetricCollector` implementation. `cast.ts` post-loop merge-review trigger. `/manta promote` command. `moveWorktreeToGraveyard` helper. Agentic rubric pre-pass. Self-certainty priming. Cross-candidate ZK harvest. `manta-merge-review` skill + slash command. Integration test. Docs.

---

## Chunk 1: Scoring Engine + Merge-Review Orchestrator Module + Bug #14 Fix

**Goal of this chunk:** A forking-realities cast whose clones are all DEAD can be scored and ranked by a composite weighted metric. The scoring engine is pure logic — no I/O, no subprocesses — fully unit-testable. Bug #14 is fixed as a prerequisite so Phase 2c's merge-review event emission doesn't trigger the audit-double-fire on idempotent cast reads.

**Files (new):**
- Create: `packages/manta-orchestrator/src/scoring.ts` — ScoringConfig schema, metric types, normalization, composite score, tie-breaking, Pareto check.
- Create: `packages/manta-orchestrator/src/merge-review.ts` — findFinalisedCasts, runMergeReview, renderMergeReviewMarkdown.
- Create: `packages/manta-orchestrator/src/merge-review-writer.ts` — MergeReviewWriter interface + fsImpl + inMemoryImpl.
- Create: `packages/manta-orchestrator/tests/scoring.test.ts` — scoring math tests.
- Create: `packages/manta-orchestrator/tests/merge-review.test.ts` — findFinalisedCasts + runMergeReview tests.
- Create: `packages/manta-orchestrator/tests/merge-review-writer.test.ts` — writer tests.

**Files (modified):**
- Modify: `packages/manta-bus/src/atomic-fs.ts:81-106` — bug #14 fix: skip `auditAppend` when `next === current` (reference-identity).
- Modify: `packages/manta-bus/tests/state/casts.test.ts` — bug #14 regression test: idempotent `casts.create` with `auditAppend` fires callback only once.
- Modify: `packages/manta-orchestrator/src/index.ts` — re-export new modules.

### File size sanity check

`scoring.ts` projected ~200 LOC (config schema + normalize + composite + tie-break + Pareto). `merge-review.ts` projected ~180 LOC (findFinalisedCasts + runMergeReview + renderer). `merge-review-writer.ts` projected ~70 LOC (parallel to `post-mortem-writer.ts` at 63 LOC). Test files ~150-200 LOC each. `atomic-fs.ts` change is 3 LOC. None crosses unwieldy.

### Tasks

#### Task 1.1 — Bug #14 fix: atomicMutateJson reference-identity skip

**What:** In `packages/manta-bus/src/atomic-fs.ts`, modify `atomicMutateJson` to skip `auditAppend` invocation when `mutator` returns reference-identical `current` (the idempotent no-op path).

**Why:** `CastsStore.create` is documented as idempotent (every clone calls it). Bug #14: `auditAppend` fires on every call regardless of whether state changed. When Phase 2c wires a real audit callback, each cast emits N duplicate audit entries instead of 1.

**How:**

- [ ] Read `packages/manta-bus/src/atomic-fs.ts:81-115` — understand the `atomicMutateJson` flow (function spans lines 81-115, not 81-106).
- [ ] After `const next = await mutator(current);` (line 99), replace the unconditional `if (auditAppend)` block (lines 101-106) with a reference-identity-gated version: `if (next !== current && auditAppend) { await auditAppend(); }`.
- [ ] **Note:** The write (tmp + rename, lines 108-110) still happens even when `next === current`. This is a redundant but harmless disk write of identical content. Do NOT skip the write — skipping it would break the lock-file invariant (proper-lockfile expects the target to exist). Phase 3+ can optimize this with a content-hash comparison if the overhead matters. (M-4 review fix.)
- [ ] Write regression test in `packages/manta-bus/tests/state/casts.test.ts`: call `casts.create` twice with identical input; an injected `auditAppend` spy fires exactly once (first call), not twice.
- [ ] Run `pnpm --filter @manta/bus test` — verify green.
- [ ] Update bug #14 in `docs/manta-bugs.md` — status: "Fixed in this commit" with approach (a) reference-identity.

**TDD sequence:** Failing test (spy fires twice under current code) → fix `atomicMutateJson` → test passes.

**Acceptance:** Bug #14 regression test green. All existing `@manta/bus` tests still green (no behavioral change for non-idempotent paths — `next !== current` always holds there, so `auditAppend` still fires).

---

#### Task 1.2 — ScoringConfig schema + defaults

**What:** Create `packages/manta-orchestrator/src/scoring.ts` with the `ScoringConfig` Zod schema and default weights.

**How:**

- [ ] Define `ScoringConfigSchema` via `z.object`:
  ```ts
  {
    weights: {
      coverage: z.number().min(0).max(1),   // default 0.30
      diff: z.number().min(0).max(1),       // default 0.20
      complexity: z.number().min(0).max(1), // default 0.20
      typeCheck: z.number().min(0).max(1),  // default 0.15
      lint: z.number().min(0).max(1),       // default 0.15
    },
    perfBonus: z.number().min(0).max(0.5),  // default 0.10
    epsilon: z.number().min(0).max(0.5),    // default 0.05
  }
  ```
  **Note:** `autoMergeThreshold` is NOT in `ScoringConfig`. It lives on `CastPolicy.auto_merge_threshold` (snake_case, on the cast manifest — already shipped in Phase 2a). `runMergeReview` reads it from `manifest.policy.auto_merge_threshold`. Single source of truth: the manifest. (M-3 review fix.)
- [ ] Export `DEFAULT_SCORING_CONFIG: ScoringConfig` with research §3 weights.
- [ ] Export `loadScoringConfig(repoRoot: string): Promise<ScoringConfig>` — reads `.manta/config/scoring.json`, falls back to defaults if file missing. Validates via `ScoringConfigSchema.parse`.
- [ ] Define raw metric types:
  ```ts
  interface RawCandidateMetrics {
    cloneId: string;
    testsPassed: boolean;        // hard gate
    coverageDelta: number;       // percentage points vs base branch
    diffLinesChanged: number;    // total lines added+removed
    complexityDelta: number;     // sum of cyclomatic delta in changed functions
    tscErrors: number;           // tsc --noEmit error count
    eslintWarnings: number;      // eslint warning count
    eslintErrors: number;        // eslint error count
    perfDeltaMs: number | null;  // Δbench_p95_ms, null if no benchmark
    selfCertainty: number | null; // 1-10 from clone broadcast, null if absent
  }
  ```
- [ ] Define `MetricCollector` interface (DI seam). Note: `selfCertainty` is NOT collected by the MetricCollector — it's read from the events log separately in `cast.ts` and injected into `RawCandidateMetrics` before passing to `runMergeReview`. This keeps MetricCollector pure-I/O (subprocess shells only, no bus dependency). (A-1 review fix.)
  ```ts
  interface MetricCollector {
    collect(cloneId: string, worktreePath: string, baseBranch: string): Promise<Omit<RawCandidateMetrics, 'selfCertainty'>>;
  }
  ```
- [ ] Write tests: schema validation (valid config, missing fields fall back, invalid weights rejected), `DEFAULT_SCORING_CONFIG` sum of weights = 1.00.

**Acceptance:** Schema + types exported. Tests green.

---

#### Task 1.3 — Metric normalization

**What:** In `scoring.ts`, add `normalizeCohort(candidates: RawCandidateMetrics[]): NormalizedCandidate[]` that maps raw metrics to `[0, 1]` per-cohort (1.0 = best of cohort).

**How:**

- [ ] Filter out candidates where `testsPassed === false` (disqualified — hard gate). Mark them in the output as `{ disqualified: true, reason: 'test_gate' }`.
- [ ] For surviving candidates, normalize each axis:
  - `coverage`: higher is better → `(val - min) / (max - min)`, 1.0 if all equal.
  - `diff`: smaller is better → invert: `1 - (log10(1 + val) - log10(1 + min)) / (log10(1 + max) - log10(1 + min))`.
  - `complexity`: smaller is better → same inversion shape as diff.
  - `typeCheck`: `1 / (1 + tscErrors)` — pre-normalized, no cohort step needed.
  - `lint`: `1 / (1 + eslintWarnings + 5 * eslintErrors)` — pre-normalized.
  - `perf`: smaller is better → inversion; null → excluded from scoring.
- [ ] Export `NormalizedCandidate`:
  ```ts
  interface NormalizedCandidate {
    cloneId: string;
    disqualified: false;
    normalized: { coverage: number; diff: number; complexity: number; typeCheck: number; lint: number; perf: number | null; };
    raw: RawCandidateMetrics;
  }
  ```
- [ ] Write tests: 3 candidates with varied metrics normalize correctly; single-candidate cohort gets 1.0 on all axes; all-disqualified returns empty; coverage tie normalizes to 1.0 for all.

**Acceptance:** Normalization math tested with concrete numeric assertions.

---

#### Task 1.4 — Composite weighted scoring

**What:** In `scoring.ts`, add `computeCompositeScore(candidate: NormalizedCandidate, config: ScoringConfig): number`.

**How:**

- [ ] `score = w.coverage * n.coverage + w.diff * n.diff + w.complexity * n.complexity + w.typeCheck * n.typeCheck + w.lint * n.lint`. If `n.perf !== null`, add `config.perfBonus * n.perf`.
- [ ] Export `rankCandidates(candidates: NormalizedCandidate[], config: ScoringConfig): RankedCandidate[]` — sorts descending by composite score. `RankedCandidate = NormalizedCandidate & { score: number; rank: number }`.
- [ ] Write tests: known inputs produce expected scores; ranking order is correct; perf bonus only applies when present.

**Acceptance:** Score math deterministic, test-pinned.

---

#### Task 1.5 — Tie-breaking chain

**What:** In `scoring.ts`, add `breakTies(tied: RankedCandidate[], config: ScoringConfig): TieBreakResult`.

**How:**

- [ ] Define `TieBreakResult = { winner: RankedCandidate; method: 'axis_priority' | 'pareto' | 'self_certainty' | 'defer' }`.
- [ ] Tie fires when `scoreRange === 0` (all identical — short-circuit directly to tie-break chain) OR `(top.score - second.score) / scoreRange < config.epsilon` where `scoreRange = max(scores) - min(scores)`. Guard against division-by-zero on `scoreRange === 0` before the division. (A-2 review fix.)
- [ ] Resolution chain:
  1. **Axis priority:** Compare in order: coverage → complexity → diff → lint → typeCheck → perf. First axis where one candidate strictly leads → winner. Deterministic in ~95% of cases.
  2. **Pareto dominance:** If still tied after axis priority, check pairwise. If one dominates the other on any non-zero axis, prefer the dominator.
  3. **Self-certainty:** If `raw.selfCertainty` is non-null for both, highest wins. Only if difference ≥ 0.5 on 1-10 scale (noise filter).
  4. **Defer:** Return `{ winner: tied[0], method: 'defer' }` — merge-review marks `manual_review_required`.
- [ ] Write tests: each resolution level tested with crafted inputs. Defer path tested (all equal).

**Acceptance:** Tie-break chain is deterministic and auditable. No first-finish bias (array order doesn't influence result).

---

#### Task 1.6 — Pareto dominance safety check

**What:** In `scoring.ts`, add `assertNoDominationInversion(ranked: RankedCandidate[]): DominationAnomaly[]`.

**How:**

- [ ] `dominates(a, b)`: `a` is ≥ on every normalized axis AND strictly > on at least one.
- [ ] Check if the top-ranked candidate (by composite score) is Pareto-dominated by any lower-ranked candidate. If yes, return anomaly: `{ dominatorCloneId, dominatedCloneId, axes }`.
- [ ] Write tests: no anomaly when top genuinely dominates; anomaly when weight mis-calibration lets a dominated candidate rank first.

**Acceptance:** Unit test for `dominates(A, B) ⇒ score(A) > score(B)` — if violated, anomaly flagged.

---

#### Task 1.7 — findFinalisedCasts

**What:** In `packages/manta-orchestrator/src/merge-review.ts`, add `findFinalisedCasts(ctx: BusContext): Promise<FinalisedCast[]>`.

**How:**

- [ ] Read `ctx.casts.list()` — all cast manifests.
- [ ] Read `ctx.registry.list()` — all clone records.
- [ ] Read `ctx.events.readAll()` — check for existing `merge_review` events.
- [ ] For each cast manifest:
  - Extract clone_ids from `manifest.clones` via `manifest.clones.map(c => c.clone_id)` (each element is `CastClonesEntry` with `clone_id` and `assignment` fields).
  - Join against `Registry.list()` (returns flat `CloneRecord[]`, NOT keyed by clone_id) via `allClones.filter(r => rosterIds.includes(r.clone_id))`. Check `filtered.length === rosterIds.length` AND `filtered.every(r => r.state === 'DEAD')`. (M-2 review fix: make join key explicit.)
  - Check if **no** event of `type === 'merge_review'` exists with `payload.cast_id === manifest.cast_id`.
  - If both conditions met → `FinalisedCast = { manifest, deadClones: CloneRecord[] }`.
- [ ] Idempotency: safe to call on every cycle — already-reviewed casts are filtered by the `merge_review` event check.
- [ ] Export `FinalisedCast`:
  ```ts
  interface FinalisedCast {
    manifest: CastManifest;
    deadClones: CloneRecord[];
  }
  ```
- [ ] Accept optional `mode` filter parameter: `findFinalisedCasts(ctx, opts?: { mode?: Mode })`. When provided, only casts with `manifest.mode === opts.mode` are returned. The `cast.ts` caller passes `{ mode: 'forking-realities' }` so recon-swarm casts are never wastefully returned. (A-5 review fix.)
- [ ] Write tests: cast with all clones DEAD and no merge_review event → found. Cast with one clone still WORKING → not found. Cast with existing merge_review event → not found. Mode filter: forking-realities cast found, recon-swarm cast filtered out.

**Acceptance:** `findFinalisedCasts` correctly filters. Test with in-memory bus context (same helpers as `orchestrator.test.ts`).

---

#### Task 1.8 — MergeReviewWriter interface

**What:** Create `packages/manta-orchestrator/src/merge-review-writer.ts` — parallel to `post-mortem-writer.ts`.

**How:**

- [ ] Define `MergeReviewDocument = { filename: string; body: string }`.
- [ ] Define `MergeReviewWriter = { write(doc: MergeReviewDocument): Promise<{ path: string }> }`.
- [ ] Implement `fsMergeReviewWriter(opts: { repoRoot: string; mergeReviewDir: string }): MergeReviewWriter` — writes atomically (tmp + rename) to `${repoRoot}/${mergeReviewDir}/${filename}`. Same safety (path traversal check) as `fsPostMortemWriter`.
- [ ] Implement `inMemoryMergeReviewWriter(): InMemoryMergeReviewWriter` — for tests.
- [ ] Add `mergeReviewDir` to `Thresholds` schema (default `'docs/merge-reviews'`).
- [ ] Write tests: fs writer creates file; in-memory writer captures document.

**Acceptance:** Writer interface + two impls. Tests green.

---

#### Task 1.9 — renderMergeReviewMarkdown

**What:** In `merge-review.ts`, add `renderMergeReviewMarkdown(review: MergeReviewResult): string`.

**How:**

- [ ] Output format per research §4:
  1. Header: `# Merge Review — cast-<castId>`.
  2. Verdict line: `auto_merge_eligible` / `manual_review_required` / `no_candidates_passed_gate` / `dominance_inversion_flagged`.
  3. Per-candidate score table (axes from scoring + composite scalar).
  4. Per-candidate `git diff --stat` summary (from `RawCandidateMetrics.diffLinesChanged` + optional detail string).
  5. Per-candidate ZK note titles (from events log, optional — filled in by Chunk 2 ZK harvest).
  6. Tie-break explanation (if tie occurred — which method resolved it).
  7. Weight adjustments (if agentic rubric pre-pass adjusted weights — logged per adjustment).
  8. Proposed merge command: `git merge manta/<castId>/<winnerId> --no-ff -m "manta-merge: chose <winnerId> (score X.XXX vs ...)"`.
- [ ] Define `MergeReviewResult`:
  ```ts
  interface MergeReviewResult {
    castId: string;
    verdict: 'auto_merge_eligible' | 'manual_review_required' | 'no_candidates_passed_gate' | 'dominance_inversion_flagged';
    ranked: RankedCandidate[];
    disqualified: DisqualifiedCandidate[];
    tieBreak: TieBreakResult | null;
    anomalies: DominationAnomaly[];
    weightAdjustments: WeightAdjustment[];
    config: ScoringConfig;
  }
  ```
- [ ] Write tests: render with 3 candidates (1 disqualified, 2 ranked), verify markdown structure.

**Acceptance:** Rendered markdown is human-readable, contains all data points the main needs to decide.

---

#### Task 1.10 — runMergeReview

**What:** In `merge-review.ts`, add `runMergeReview(ctx: BusContext, opts: RunMergeReviewOptions): Promise<RunMergeReviewResult>`.

**How:**

- [ ] Define `RunMergeReviewOptions`:
  ```ts
  interface RunMergeReviewOptions {
    castId: string;
    candidates: RawCandidateMetrics[];
    config: ScoringConfig;
    weightAdjustments?: WeightAdjustment[];
    writer: MergeReviewWriter;
  }
  ```
- [ ] Flow:
  1. `normalizeCohort(candidates)` — split into normalized + disqualified.
  2. If no candidates passed the gate → verdict `no_candidates_passed_gate`, write review, emit event, return.
  3. `rankCandidates(normalized, config)`.
  4. `assertNoDominationInversion(ranked)` — if anomalies → verdict `dominance_inversion_flagged`.
  5. Check tie within ε → `breakTies(tied, config)` if needed.
  6. Read `autoMergeThreshold` from the cast manifest: `(await ctx.casts.read(opts.castId)).policy.auto_merge_threshold`. Determine verdict: anomalies → `dominance_inversion_flagged`; tie resolved by `defer` → `manual_review_required`; `auto_merge_threshold === null` → `manual_review_required` (Phase 2 always manual); otherwise compare top score margin against threshold → `auto_merge_eligible` or `manual_review_required`. (M-3 review fix: single source of truth is `CastPolicy.auto_merge_threshold`, not ScoringConfig.)
  7. Build `MergeReviewResult`, render markdown, write via `writer`.
  8. Emit `merge_review` event to `ctx.events.append({ type: 'merge_review', payload: { cast_id, verdict, winner_clone_id, scores, tie_break_method } })`.
- [ ] Return `RunMergeReviewResult = { result: MergeReviewResult; event: BusEvent; written: { path: string } }`.
- [ ] Write tests: full flow with 3 candidates — one disqualified, two scored, winner identified. Verify event emitted. Verify writer called. Verify idempotency (calling twice for same cast doesn't double-emit — `findFinalisedCasts` filters it on next cycle).

**Acceptance:** Full merge-review flow unit-tested with in-memory bus + in-memory writer. No real I/O.

---

#### Task 1.11 — Orchestrator integration (optional — deferred to Chunk 2 discussion)

**What:** Decide whether `runMergeReview` is called from `Orchestrator.runCycle()` or from `cast.ts` post-loop.

**Decision:** **`cast.ts` post-loop** (not inside `runCycle`). Rationale:
- Metric collection (Chunk 2) is slow (subprocess shells). Putting it inside `runCycle()` blocks the tick loop.
- `runCycle()` is called repeatedly; merge-review is a once-per-cast operation.
- The tick loop exits when `allDone()` returns true. After exit, `cast.ts` has all the context (cloneIds, worktrees, mode) to trigger merge-review.
- Phase 5+ daemon mode may move it into the orchestrator, but that's a different architecture.

**What this task does in Chunk 1:** Export all types and functions needed by Chunk 2's `cast.ts` integration. Ensure `@manta/orchestrator` `index.ts` re-exports everything.

- [ ] Re-export from `packages/manta-orchestrator/src/index.ts`: `scoring.ts` (all types + functions), `merge-review.ts` (all types + functions), `merge-review-writer.ts` (all types + functions).
- [ ] Verify clean build: `pnpm --filter @manta/orchestrator build`.
- [ ] Run whole-workspace test sweep: `pnpm -r test`.

**Acceptance:** `@manta/orchestrator` builds clean, all workspace tests green.

---

## Chunk 2: CLI Wiring + Metric Collectors + Promote + Graveyard + Skill + ZK Harvest

**Goal of this chunk:** A forking-realities cast produces a scored `merge-review.md` after all clones die, and the operator can `/manta promote <castId>/<cloneId>` to merge the winner. Loser worktrees are moved to the graveyard. Cross-candidate ZK notes are harvested. The agentic rubric pre-pass adjusts weights based on project configuration.

**Files (new):**
- Create: `packages/manta-cli/src/commands/merge-review-collector.ts` — real `MetricCollector` impl.
- Create: `packages/manta-cli/src/commands/promote.ts` — `/manta promote <castId>/<cloneId>` command.
- Create: `packages/manta-cli/src/spawner/graveyard.ts` — `moveWorktreeToGraveyard` + `listGraveyard`.
- Create: `packages/manta-cli/src/commands/rubric-prepass.ts` — agentic rubric weight adjustment.
- Create: `packages/manta-cli/src/commands/zk-harvest.ts` — cross-candidate ZK harvest.
- Create: `skills/manta-merge-review/SKILL.md` — main-side merge-review skill.
- Create: `commands/manta-promote.md` — slash command file.
- Create: `docs/internals/merge-review-scoring.md` — weight rationale + agentic rubric explanation.
- Create: `packages/manta-cli/tests/commands/merge-review-collector.test.ts`.
- Create: `packages/manta-cli/tests/commands/promote.test.ts`.
- Create: `packages/manta-cli/tests/commands/rubric-prepass.test.ts`.
- Create: `packages/manta-cli/tests/spawner/graveyard.test.ts`.
- Create: `packages/manta-cli/tests/integration/merge-review.test.ts` — end-to-end integration.

**Files (modified):**
- Modify: `packages/manta-cli/src/commands/cast.ts:272-333` — post-loop merge-review trigger for forking-realities.
- Modify: `packages/manta-cli/src/bin/manta.ts` — wire `promote` command.
- Modify: `packages/manta-cli/src/runtime.ts` — add `mergeReviewWriter` to `Runtime`.
- Modify: `packages/manta-cli/src/spawner/priming.ts` — self-certainty broadcast instruction in forking-realities priming.
- Modify: `skills/manta-as-clone/SKILL.md` — v0.0.5: self-certainty section for forking-realities clones.
- Modify: `docs/user/forking-realities.md` — merge-review lifecycle section replacing Phase 2b caveat.
- Modify: `CHANGELOG.md` — Phase 2c entry.
- Modify: `packages/manta-orchestrator/src/thresholds.ts` — add `mergeReviewDir` default.

### File size sanity check

`merge-review-collector.ts` projected ~150 LOC (5 subprocess shells + output parsers). `promote.ts` projected ~100 LOC (git merge + graveyard move). `graveyard.ts` projected ~60 LOC (rename + sidecar). `rubric-prepass.ts` projected ~100 LOC (read 3 config files + adjust weights). `zk-harvest.ts` projected ~80 LOC (diff comparison + convergence filter + ZK emit). `manta-merge-review/SKILL.md` ~80 lines. Tests ~100-150 LOC each. Integration test ~200 LOC. None crosses unwieldy.

### Tasks

#### Task 2.1 — Real MetricCollector implementation

**What:** Create `packages/manta-cli/src/commands/merge-review-collector.ts` implementing the `MetricCollector` interface from `@manta/orchestrator`.

**How:**

- [ ] Implement `createMetricCollector(): MetricCollector` with `collect(cloneId, worktreePath, baseBranch)`:
  1. **Test gate:** `execa('pnpm', ['-r', 'test'], { cwd: worktreePath })` — `testsPassed = exitCode === 0`. Swallow non-zero gracefully.
  2. **Coverage delta:** After test run, read `coverage/coverage-summary.json` (vitest default output path) from worktree. Parse `total.lines.pct`. Compute delta vs base branch coverage (run same on `baseBranch` HEAD or read from `.manta/config/base-coverage.json` if cached). If coverage file missing → `coverageDelta = 0`.
  3. **Diff size:** `execa('git', ['diff', '--stat', '--numstat', baseBranch], { cwd: worktreePath })`. Parse total lines added + removed.
  4. **Complexity delta:** Read changed files via `git diff --name-only`. For `.ts`/`.js` files, count cyclomatic-complexity-approximation via simple regex (count of `if|else|for|while|switch|case|catch|&&|\|\||\?` tokens in changed hunks). This is an approximation — Phase 3+ can integrate a real AST complexity tool.
  5. **Type-check:** `execa('npx', ['tsc', '--noEmit'], { cwd: worktreePath })`. Count error lines in stderr.
  6. **Lint:** `execa('npx', ['eslint', '.', '--format', 'json'], { cwd: worktreePath })`. Parse JSON output, count warnings + errors.
  7. **Perf delta:** Check for `vitest.bench` or `bench` script in worktree `package.json`. If absent → `null`. If present → run and parse p95. (Phase 2 ships with `null` — perf benchmark infrastructure deferred.)
  8. **Self-certainty:** NOT collected by MetricCollector — read from events log in `cast.ts` post-loop and injected into `RawCandidateMetrics.selfCertainty` before calling `runMergeReview`. See Task 2.3 code snippet. (A-1 review fix.)
- [ ] Each subprocess has a timeout (30s for test, 15s for tsc/eslint, 5s for git). Timeout → metric defaults to worst-case value.
- [ ] Write tests: mock `execa` responses for each metric. Test timeout handling. Test missing coverage file fallback.

**Acceptance:** `MetricCollector` returns `RawCandidateMetrics` for each clone. Fully unit-tested with mocked subprocesses.

---

#### Task 2.2 — Agentic rubric pre-pass

**What:** Create `packages/manta-cli/src/commands/rubric-prepass.ts` — reads project config files and adjusts scoring weights.

**How:**

- [ ] `adjustWeightsFromProject(repoRoot: string, baseConfig: ScoringConfig): Promise<{ config: ScoringConfig; adjustments: WeightAdjustment[] }>`.
- [ ] Read `tsconfig.json` (if exists):
  - `strict: true` + `noUncheckedIndexedAccess: true` → bump `typeCheck` weight by +0.10, reduce `diff` by -0.10.
  - `strict: true` alone → bump `typeCheck` by +0.05, reduce `diff` by -0.05.
  - Log adjustment: `{ axis: 'typeCheck', delta: +0.10, reason: 'tsconfig strict + noUncheckedIndexedAccess' }`.
- [ ] Read `.eslintrc.*` / `eslint.config.*` (if exists):
  - Count enabled rules. If > 100 rules → "strict eslint" → bump `lint` by +0.05, reduce `complexity` by -0.05.
  - Heuristic, not exact — sufficient for Phase 2 weight nudging.
- [ ] Read `vitest.config.ts` / `vitest.config.js` (if exists):
  - If `coverage.thresholds` present with high thresholds (≥ 90%) → bump `coverage` by +0.05, reduce `diff` by -0.05.
- [ ] Normalize adjusted weights to sum = 1.00 after all adjustments (proportional scaling).
- [ ] Emit each adjustment as event: `ctx.events.append({ type: 'weight_adjustment', payload: adjustment })`.
- [ ] Write tests: project with strict tsconfig → weights adjusted correctly. Project with no config files → no adjustments. Weight normalization preserves sum = 1.00.

**Acceptance:** Rubric pre-pass tested with fixture config files. Adjustments are auditable.

---

#### Task 2.3 — cast.ts post-loop merge-review trigger

**What:** Modify `packages/manta-cli/src/commands/cast.ts` to trigger merge-review after the tick loop exits for forking-realities casts.

**How:**

- [ ] After `loopResult` (line 289), before the budget-abort block (line 299), add a forking-realities check:
  ```ts
  if (opts.mode === 'forking-realities' && !loopResult.aborted) {
    const config = await loadScoringConfig(rt.repoRoot);
    const { config: adjustedConfig, adjustments } = await adjustWeightsFromProject(rt.repoRoot, config);
    const collector = createMetricCollector();
    const allEvents = await rt.ctx.events.readAll();
    const candidates = await Promise.all(
      cloneIds.map(async (id) => {
        const expectedBranch = `manta/${opts.castId}/${id}`;
        const wt = worktrees.find(w => w.branch === expectedBranch)!;
        const collected = await collector.collect(id, wt.path, 'main');
        // Self-certainty read from events log (not from MetricCollector — A-1 fix)
        const certEvent = allEvents.find(e =>
          e.clone_id === id && e.type === 'broadcast' &&
          (e.payload as Record<string, unknown>)?.event_type === 'self_certainty'
        );
        const selfCertainty = certEvent
          ? ((certEvent.payload as Record<string, unknown>)?.score as number) ?? null
          : null;
        return { ...collected, selfCertainty };
      }),
    );
    await runMergeReview(rt.ctx, {
      castId: opts.castId,
      candidates,
      config: adjustedConfig,
      weightAdjustments: adjustments,
      writer: rt.mergeReviewWriter,
    });
  }
  ```
- [ ] Import `loadScoringConfig`, `runMergeReview` from `@manta/orchestrator` and `createMetricCollector`, `adjustWeightsFromProject` from local modules.
- [ ] Wire `mergeReviewWriter` into `Runtime` (Task 2.4).
- [ ] If merge-review fails (e.g. subprocess timeout), log error via `reporter.warn` and continue — merge-review failure should not fail the cast. The operator can re-run scoring manually.
- [ ] Write test in `packages/manta-cli/tests/commands/cast.test.ts`: forking-realities cast triggers merge-review; recon-swarm cast does not.

**Acceptance:** Forking-realities casts produce `docs/merge-reviews/<castId>.md`. Recon-swarm casts skip merge-review.

---

#### Task 2.4 — Runtime mergeReviewWriter wiring

**What:** Modify `packages/manta-cli/src/runtime.ts` to include `mergeReviewWriter` in `Runtime`.

**How:**

- [ ] Import `fsMergeReviewWriter` from `@manta/orchestrator`.
- [ ] Add `mergeReviewWriter` to `Runtime` interface.
- [ ] Wire in `createRuntime`:
  ```ts
  const mergeReviewWriter = fsMergeReviewWriter({
    repoRoot,
    mergeReviewDir: thresholds.mergeReviewDir,
  });
  ```
- [ ] Ensure `docs/merge-reviews/` directory is created (add to `mkdir` calls at line 55-57).
- [ ] Update `Thresholds` schema in `packages/manta-orchestrator/src/thresholds.ts` — add `mergeReviewDir: string` with default `'docs/merge-reviews'`.

**Acceptance:** `Runtime.mergeReviewWriter` available. Directory created on startup.

---

#### Task 2.5 — moveWorktreeToGraveyard helper

**What:** Create `packages/manta-cli/src/spawner/graveyard.ts`.

**How:**

- [ ] `moveWorktreeToGraveyard(opts: { repoRoot, cloneId, castId, worktreePath, branch }): Promise<{ graveyardPath: string }>`:
  1. Target: `.manta/graveyard/<castId>-<cloneId>/`.
  2. `git worktree move <worktreePath> <graveyardPath>`.
  3. Write `info.json` sidecar: `{ castId, cloneId, movedAt: Date.now(), originalBranch: branch }`.
  4. Return `{ graveyardPath }`.
- [ ] `listGraveyard(repoRoot: string): Promise<GraveyardEntry[]>` — reads `.manta/graveyard/*/info.json`.
- [ ] Write tests: move succeeds, sidecar written, list returns entry. Move to non-existent graveyard dir creates it.

**Acceptance:** Graveyard helper tested. Worktrees can be moved + listed.

---

#### Task 2.6 — /manta promote command

**What:** Create `packages/manta-cli/src/commands/promote.ts` + wire into `bin/manta.ts`.

**How:**

- [ ] Parse argument: `<castId>/<cloneId>` (e.g. `cast-123/B`).
- [ ] Validate: read cast manifest via `ctx.casts.read(castId)`. Verify `cloneId` is in the roster. Verify merge-review exists (`merge_review` event in events log for this cast).
- [ ] Merge: `git merge manta/<castId>/<cloneId> --no-ff -m "manta-merge: promote <cloneId> from cast <castId> (score X.XXX)"`. Score read from the merge-review event payload.
- [ ] Graveyard losers: for each non-winner clone in the roster, call `moveWorktreeToGraveyard`. If winner worktree doesn't need moving (it's merged), also remove it: `removeWorktree({ repoRoot, worktreePath, branch })`.
- [ ] Emit `promote` event: `ctx.events.append({ type: 'promote', payload: { cast_id, winner_clone_id, losers_graveyard'd } })`.
- [ ] Wire into `bin/manta.ts` alongside existing commands.
- [ ] Write tests: promote merges correct branch; losers graveyard'd; event emitted; invalid castId/cloneId rejected; promote without merge-review rejected.

**Acceptance:** `/manta promote` works end-to-end. Losers in graveyard. Winner merged.

---

#### Task 2.7 — Cross-candidate ZK harvest

**What:** Create `packages/manta-cli/src/commands/zk-harvest.ts` — after ranking, extract convergence-filtered insights from losing candidates.

**How:**

- [ ] `harvestCrossCandidateInsights(opts: { castId, cloneIds, worktrees, baseBranch, memoryWriters }): Promise<string[]>`:
  1. For each clone, read `git diff --name-only <baseBranch>` in worktree.
  2. Find files changed by **2+ candidates** — convergent rewrites.
  3. For each convergent file, extract a one-line insight: "Clones X and Y both rewrote `<file>` — likely a spec gap or unclear boundary."
  4. Write 1-3 ZK notes via `memoryWriters.zkWrite({ clone_id: 'main', title: '...', content: '...', tags: ['cast-<castId>', 'loser-insights', '<topic>'] })`.
  5. Return note paths.
- [ ] Filter: ignore insights unique to a single candidate (noise at small N per research §6).
- [ ] Write tests: 2 of 3 clones change same file → convergence insight emitted. No convergence → no notes.

**Acceptance:** ZK harvest emits convergence-filtered notes. Tested.

---

#### Task 2.8 — Self-certainty: schema widening + priming + skill update

**What:** Widen `BroadcastEventTypeSchema` to accept `'self_certainty'`, then add the broadcast instruction to forking-realities clone priming and skill.

**How:**

- [ ] **Schema widening (prerequisite — `@manta/bus`):** In `packages/manta-bus/src/schema.ts:151`, change `z.enum(['breakthrough', 'blocker', 'dependency'])` to `z.enum(['breakthrough', 'blocker', 'dependency', 'self_certainty'])`. This is additive, non-breaking. Write test in `packages/manta-bus/tests/` confirming broadcast with `event_type: 'self_certainty'` parses successfully. (M-1 review fix.)
- [ ] In `packages/manta-cli/src/spawner/priming.ts`, add to the forking-realities section of the priming template. **Use the correct field name `event_type`, not `type`** (the bus schema field is `event_type` per `BroadcastInputSchema`):
  ```
  Before your final commit, broadcast your confidence in the solution:
  manta.broadcast({ clone_id: '{CLONE_ID}', event_type: 'self_certainty', payload: { score: <1-10>, rationale: '<one sentence>' } })
  ```
  This is a soft prior (per `claude-code-pitfalls.md` §1) — the tie-break chain handles absence gracefully (`selfCertainty = null`). (M-1 review fix: correct field name.)
- [ ] Update `skills/manta-as-clone/SKILL.md` → v0.0.5:
  - Add `### Self-certainty (forking-realities only)` section.
  - "Before your final commit, broadcast a self-certainty score (1-10) rating your confidence in the solution. This is used as a tie-breaker when composite scores are within noise tolerance."
  - Place in **Allowed** section (not Required — it's a soft signal per pitfalls §1).
- [ ] Update version number in skill frontmatter.
- [ ] Write test in `packages/manta-cli/tests/spawner/priming.test.ts`: forking-realities priming includes `self_certainty`. Recon-swarm priming does not.

**Acceptance:** Priming and skill updated. Test green. Per pitfalls §1: this is guidance, not enforcement — the scoring engine handles `null` self-certainty.

---

#### Task 2.9 — manta-merge-review skill + slash command

**What:** Create `skills/manta-merge-review/SKILL.md` and `commands/manta-promote.md`.

**How:**

- [ ] `skills/manta-merge-review/SKILL.md`:
  ```yaml
  ---
  name: manta-merge-review
  description: Guide for the main agent to interpret merge-review output and promote a winner
  audience: main
  version: 0.0.1
  related:
    - manta-cast-decide
    - manta-as-clone
  ---
  ```
  Sections:
  - **When this skill applies:** After a forking-realities cast completes and `docs/merge-reviews/<castId>.md` is generated.
  - **Reading the merge-review:** Explain the score table, verdict types, tie-break explanation, weight adjustments.
  - **Promoting a winner:** `/manta promote <castId>/<cloneId>` — what it does (merge, graveyard, event).
  - **When to override scores:** If domain knowledge suggests the lower-scored candidate is better (e.g. the higher-scored one took a risky shortcut), override is the operator's right. Log reasoning in the promote event.
  - **Forbidden:** Auto-promoting without reading the review. Ignoring `dominance_inversion_flagged` verdicts.
- [ ] `commands/manta-promote.md`:
  ```yaml
  ---
  name: manta:promote
  description: Merge the winning candidate from a forking-realities cast
  target: main
  aliases: []
  ---
  ```
  Usage: `/manta promote <castId>/<cloneId>`.
- [ ] Run `pnpm --filter @manta/skill-validator validate` — both files pass.

**Acceptance:** Skill and slash command pass validator. Content matches merge-review output format.

---

#### Task 2.10 — Integration test

**What:** Create `packages/manta-cli/tests/integration/merge-review.test.ts` — end-to-end test with fake runners.

**How:**

- [ ] Set up: create runtime with in-memory context. Register 3 clones in a forking-realities cast. Mark all DEAD.
- [ ] Provide a `FakeMetricCollector` that returns known metrics:
  - Clone A: tests pass, coverage +5%, 50 lines changed, complexity delta 2, 0 tsc errors, 3 lint warnings.
  - Clone B: tests pass, coverage +3%, 30 lines changed, complexity delta 1, 0 tsc errors, 0 lint warnings.
  - Clone C: tests fail (disqualified).
- [ ] Call `runMergeReview` with the fake metrics.
- [ ] Assert:
  - Clone C is disqualified.
  - Clone A or B wins (verify with concrete expected score).
  - `merge-review.md` written to the writer.
  - `merge_review` event emitted.
  - Verdict is `manual_review_required` (Phase 2 always manual).
  - No dominance inversion.
- [ ] Test `findFinalisedCasts`: before merge-review → cast found. After merge-review → cast not found (idempotent).
- [ ] Test promote flow: call promote with winner → merge event emitted. Call promote with non-existent cast → error.

**Acceptance:** Integration test exercises the full merge-review → promote pipeline with fake I/O. Green.

---

#### Task 2.11 — Docs update

**What:** Update user-facing and internal docs.

**How:**

- [ ] Update `docs/user/forking-realities.md`:
  - Replace Phase 2b caveat ("merge-review not yet shipped") with full merge-review lifecycle section.
  - Explain: cast completes → `docs/merge-reviews/<castId>.md` → read review → `/manta promote <castId>/<cloneId>`.
  - Note: auto-merge disabled in Phase 2.
- [ ] Create `docs/internals/merge-review-scoring.md`:
  - Weight rationale (why coverage 0.30, etc. — condensed from research §3).
  - Agentic rubric pre-pass explanation.
  - Self-certainty tie-breaker.
  - How to tune: edit `.manta/config/scoring.json`.
- [ ] Update `CHANGELOG.md`: Phase 2c entry.
- [ ] Update `README.md` Phase status table if needed.
- [ ] Run `pnpm --filter @manta/skill-validator validate` — all skills pass.
- [ ] Run full workspace test sweep: `pnpm -r test`.

**Acceptance:** Docs committed atomically with code. Validator clean. All tests green.

---

## Risk hedges

1. **Metric collection subprocess timeouts.** Real `pnpm test` in a worktree can take minutes. Timeouts are per-subprocess (30s test, 15s tsc/eslint). If a project's test suite takes > 30s, the metric defaults to worst-case. Phase 3+ can make timeouts configurable via `.manta/config/scoring.json`.

2. **Complexity metric is a regex approximation.** Counting `if|for|while|&&` tokens in diff hunks is not real cyclomatic complexity. It's sufficient for Phase 2's small-N scoring where the signal-to-noise ratio is already low (N=2-3). Phase 3+ can integrate `escomplex` or a TS-compiler-based walker.

3. **Self-certainty is a soft signal.** Per `claude-code-pitfalls.md` §1, clones may not broadcast it. The scoring engine handles `null` — self-certainty only fires as a tie-breaker, never as a primary signal. If dogfood shows clones consistently skip it, we can remove the priming instruction and rely on axis-priority + Pareto alone.

4. **Agentic rubric pre-pass heuristics.** The weight adjustments are simple rule-based (if strict tsconfig → bump type weight). A more sophisticated version would use an LLM to read the project's conventions and suggest weights (Scale Labs approach). That's Phase 3+ — the current heuristics are a 90% solution that's fully deterministic and auditable.

5. **`git merge` conflicts during promote.** If the winner's branch conflicts with the current branch (rare — worktrees are based on HEAD), `git merge` will fail. The promote command should surface the conflict clearly and let the operator resolve manually. Not a crash — a graceful degradation.

6. **Coverage collection depends on vitest's JSON reporter.** If the project uses a different test runner or coverage format, coverage delta will be 0. Phase 3+ can add pluggable coverage parsers. For Phase 2 (Manta building Manta), vitest is the only runner.

7. **Bug #14 fix changes `atomicMutateJson` behavior.** The reference-identity check (`next !== current`) is the recommended approach from the bug log. All existing callers of `atomicMutateJson` return a new object from their mutators (registry, contracts, locks, claims) — none rely on `auditAppend` firing on no-op. The only caller that returns `current` unchanged is `CastsStore.create` on the idempotent path. Regression risk is low; the bug #14 test explicitly verifies the behavioral change.
