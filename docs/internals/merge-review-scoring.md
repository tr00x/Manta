# Merge-Review Scoring — Weight Rationale & Agentic Rubric

## Default weights (v1)

| Axis | Weight | Rationale |
|---|---|---|
| Coverage delta | 0.30 | Primary quality signal — code that improves test coverage is objectively better-tested. |
| Diff size | 0.20 | Smaller diffs are easier to review, less likely to introduce regressions. Log-scaled. |
| Complexity delta | 0.20 | Lower cyclomatic complexity in changed code = more maintainable. Log-scaled. |
| TypeCheck (tsc errors) | 0.15 | Zero type errors is table-stakes; the weight rewards cleaner type usage. |
| Lint (eslint) | 0.15 | Eslint errors weighted 5x warnings. Clean lint = fewer review nits. |
| Perf bonus | +0.10 | Additive bonus when benchmark data exists. Currently ships with `null` (no benchmark infra). |

Weights sum to 1.00 (excluding perf bonus which is additive). Stored in `.manta/config/scoring.json`; missing file → defaults above.

## Metric normalization

Each axis is normalized to `[0, 1]` per-cohort (1.0 = best of cohort):
- **Higher-is-better** (coverage): linear min-max.
- **Lower-is-better** (diff, complexity, perf): log-scaled inversion `1 - (log₁₀(1+v) - min) / (max - min)` (the code uses `Math.log10`).
- **Pre-normalized** (typeCheck, lint): not cohort-relative — computed from the candidate's own raw counts. typeCheck = `1 / (1 + tscErrors)`; lint = `1 / (1 + eslintWarnings + 5 · eslintErrors)` (errors weighted 5× warnings).

Single-candidate cohort → 1.0 on the cohort-relative axes only (coverage, diff, complexity, and perf when benchmark data exists). The pre-normalized axes (typeCheck, lint) stay absolute, so a lone candidate keeps its `1/(1+errors)` value on those — it is not promoted to 1.0.

## Hard test gate

The test command is **toolchain-detected, not hardcoded.** `detectToolchain()` (`packages/manta-cli/src/commands/toolchain.ts`) inspects the worktree root and returns the matching gate: `pnpm test` (pnpm workspace), `npm test` (a bare `package.json` that ships a `test` script), `python -m pytest -q` (pyproject/setup.py), `cargo test`, or `go test ./...`. An unrecognised project type yields `test: null` — no gate runs.

A candidate is **disqualified** (not down-ranked) only when a test gate actually **ran and failed** — `testsRan !== false && !testsPassed` (bug #M9). When no gate is applicable (`testsRan === false`: unrecognised toolchain or no test command) the candidate is **not** disqualified; it survives into scoring on its other axes. Callers that omit `testsRan` are treated as "a test ran" (legacy behaviour). Disqualified candidates appear in the "Disqualified" section of the merge-review with reason `test_gate`.

## Tie-breaking chain

Tie-breaking engages when more than one candidate sits within `ε × topScore` of the top composite score (`runMergeReview`, default ε = 0.05). `breakTies` then re-filters those contenders to the ones within `ε` of the normalized score *range* (`isTied`: `(topScore − score) / scoreRange < ε`) before applying the chain:

1. **Axis priority**: coverage → complexity → diff → lint → typeCheck → perf. First axis where one candidate strictly leads → winner.
2. **Pareto dominance**: if one candidate is ≥ on every axis and strictly > on at least one → winner.
3. **Self-certainty**: clones broadcast `{ event_type: 'self_certainty', payload: { score: 1-10 } }` before death. Highest score wins if difference ≥ 0.5.
4. **Defer**: no automatic winner — verdict = `manual_review_required`.

No first-finish bias. Array order does not influence results.

## Dominance inversion safety

`assertNoDominationInversion` checks if the top-ranked candidate (by composite score) is Pareto-dominated by a lower-ranked one. If yes → verdict `dominance_inversion_flagged` + forced manual review. This catches weight mis-calibration.

## Agentic rubric pre-pass

Before scoring, the CLI reads project configuration and adjusts weights:

| Signal | Adjustment | Rationale |
|---|---|---|
| `tsconfig.json` strict mode | typeCheck +0.05, diff −0.05 | Strict TS projects benefit more from clean types. |
| strict + noUncheckedIndexedAccess | typeCheck +0.10, diff −0.10 | Maximum strictness = maximum type weight. |
| eslint > 100 rules | lint +0.05, complexity −0.05 | Strict linting config = lint matters more. |
| vitest coverage threshold ≥ 90% | coverage +0.05, diff −0.05 | High coverage bar = coverage delta matters more. |

After adjustments, weights are re-normalized to sum = 1.00. Each adjustment is logged as an event and rendered in the merge-review document.

## Tuning

Edit `.manta/config/scoring.json`:

```json
{
  "weights": {
    "coverage": 0.30,
    "diff": 0.20,
    "complexity": 0.20,
    "typeCheck": 0.15,
    "lint": 0.15
  },
  "perfBonus": 0.10,
  "epsilon": 0.05
}
```

The schema validates via Zod at load time. Invalid config → hard error (not silent fallback).

## Auto-merge threshold

`CastPolicy.auto_merge_threshold` on the cast manifest (single source of truth). It currently defaults to `null` → always `manual_review_required`. A future release may tune it based on telemetry.
