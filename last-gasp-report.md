# Clone A — last gasp: Budget repivot ($ → usage-aware)

**Cast:** cast-1780252962415 · mode bug-hunt (实为 implementation) · clone A
**Verdict:** core pivot COMPLETE & compile-clean; full `pnpm gate` NOT run within the 20-min TTL → **no green claim**. Honest remaining-work list below.

## Symptom (the conceptual bug)
Claude Code is a **subscription** (Pro/Max), not pay-per-token. The entire dollar budget model
(`--budget-per-clone-usd`, `Daily budget $X/$Y`, `per_cast_usd`…) was built on a false premise — a
subscription user pays nothing per token. The real constraints are the subscription's **usage/rate
limit** and **parallelism**.

## Findings — where the dollar model lived
Two independent dollar chains:
1. **Repivotable chain** (all inside my allowed scope): `BudgetConfigSchema.{per_cast_usd,per_clone_usd,daily_cap_usd,cost_estimates}`,
   `DailySpend{Entry,State}.{estimated_cost_usd,cost_type,spent_usd}`, `ResolvedBudgetConfig.{perCastUsd,perCloneUsd,dailyCapUsd,costEstimates}`,
   `CostEstimate.{perCloneCostUsd,totalEstimatedUsd,perCloneBudgetUsd}`, `DowngradeOption/Advice.{estimatedCostUsd,remainingBudgetUsd}`,
   `pre-spawn-gate` daily-cap, `cost`/`limit` output, the 3 CLI dollar flags, the cast-decide skill.
2. **Forbidden-anchored chain** (left intact, by scope-fence): `CloneAssignment.budget_usd` →
   `spawner/snapshot-builder.budgetUsd` → `@manta/snapshot` `budget.dollarsTotal/dollarsUsed`. The spawner +
   snapshot package are OUT of my allowedPaths and explicitly fenced ("spawner guard", "statusline"). This is
   an internal per-clone resource cap, never user-facing.

## Root cause / fix applied
Repivoted chain (1) to a **token-estimate** usage model (a proxy for subscription usage, NOT dollars) and
added two real usage gates. Defaults recalibrated to realistic token counts (recon 150k, heavy 300k,
council 500k; per-cast 1.5M; daily-cap 5M).

### Source changes (DONE, tsc -b --force clean for these surfaces)
- **`@manta/bus schema.ts`**: `estimated_cost_usd→estimated_tokens`, `cost_type→estimate_type`,
  `spent_usd→tokens_estimated`, `per_*_usd→token_estimate_per_*`, `daily_cap_usd→daily_token_cap`,
  `cost_estimates→token_estimates`; **added** `max_parallel_clones` + `max_casts_per_hour`.
- **`daily-spend.ts`**: renamed fields; repurposed as a usage ledger; added `castsToday()`.
- **`budget-config.ts`**: renamed `Resolved*` fields, recalibrated token defaults, resolves the two new caps.
- **`cost-estimator.ts` / `auto-downgrade.ts` / `pre-spawn-gate.ts`**: renamed `*Usd`→token fields; daily-cap is now a token-estimate cap.
- **`cast.ts`**: dropped the dollar cumulative-gate message; **added real `--max-parallel-clones` gate**
  (rejects cloneCount > cap, before any state commit) and **real `--max-casts-per-hour` gate** (counts
  `cast_start` in the charge log over the trailing hour; NaN-reject preserved via `parsePositiveIntOption`).
  Internal `budgetUsd` plumbing kept for the forbidden spawner anchor.
- **`bin/manta.ts`**: removed `--budget-per-clone-usd`, `--budget-per-cast-usd`, `--daily-cap-usd`; added
  `--max-parallel-clones`, `--max-casts-per-hour`, `--max-tokens-estimate`; internal budget now hardcoded
  constants (not user-tunable).
- **`option-parsers.ts`**: removed now-dead `parsePositiveFloatOption` (no dollar flags left); int parser keeps NaN-reject.
- **`cost.ts`**: pure usage output — casts/clones today, cast-rate this hour, token estimate, charges + parallelism cap. Zero `$`.
- **`limit.ts`**: usage keys (`max_parallel_clones`, `max_casts_per_hour`, `token_estimate_*`, `daily_token_cap`).
- **`skills/manta-cast-decide`**: dollar/cost-gate framing → usage/rate/parallelism reasoning.

### Tests converted (DONE)
`charge-schemas.test`, `daily-spend.test`, `auto-downgrade.test`, `cost-estimator.test` (values rewritten to
tokens), `pre-spawn-gate.test` (removed dead options), `budget-config.test` (token defaults + keys),
`charge-budget.test`, `option-parsers.test` (float block removed). Mechanical field rename via perl, value
asserts hand-fixed in cost-estimator + budget-config.

## ⚠️ REMAINING (ran out of TTL — main must finish before merge)
1. **Runtime value-assert conversion not finished** in: `commands/cost.test.ts` and `commands/limit.test.ts`
   (assert old dollar stdout / keys), `auto-downgrade.test.ts` + `daily-spend.test.ts` numeric expectations,
   and any **integration dry-run** tests asserting dollar dry-run output. These will RED at runtime until
   updated — they are honest failures, not skips.
2. **`pnpm gate` (vitest) NOT executed** within the 20-min deadline. `tsc -b --force` shows zero errors
   attributable to this change (the only residuals are PRE-EXISTING orchestrator `TestBusContext` / rubric
   `unknown` errors, out of scope and unrelated to dollars). **No green claim made.**
3. **`docs/user` NOT scrubbed**: `charge-system.md` (L1/L2 budget, `manta limit` example), `getting-started.md`
   (`--budget-per-*-usd` in the cast example — now a broken flag), `recon-swarm.md`, `refactor-wave.md`,
   `forking-realities.md` (asymmetric-budget `$` example). README is already clean.
4. **`bin/manta-statusline.ts` (FORBIDDEN to edit)** reads `spent_usd` from the daily-spend JSON and
   `daily_cap_usd` from budget.json — both renamed. It reads them as untyped optional fields and falls back
   to `null`, so it **degrades gracefully** (no budget shown) rather than crashing, but the statusline budget
   widget is now dead until a follow-up cast updates it in step with this rename.
5. **Gate test for the new caps**: gates are implemented + before-state-commit, but a dedicated
   parallelism/rate-cap test in `commands/cast.test.ts` was not written within TTL. Acceptance asks for one.

## Cross-layer dependencies
- `@manta/snapshot` `budget.dollars*` + `spawner/snapshot-builder.budgetUsd` remain dollar-named on purpose
  (fenced). A future cast should rename that chain to `tokens` to fully erase the internal dollar vocabulary.
- `manta-statusline` (fenced) must be updated together with the daily-spend field rename.

## Acceptance status
- ✅ grep: ZERO user-facing `$`/usd/`--*-usd` in CLI help, cost output, cast-decide skill, README, limit, charges
  (only explanatory "NOT dollars" negations + the internal non-printed `budgetUsdPerClone` identifier remain).
- ⚠️ `pnpm gate` green: NOT verified (TTL). tsc-clean for changed surfaces.
- ⚠️ all dollar tests → usage: ~70% done; cost/limit/integration stdout asserts remain.
- ⚠️ explicit cap-gate test: gates implemented, test not written.
