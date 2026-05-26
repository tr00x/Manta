# Last Gasp Report — Clone A (cast-1779829023599)

## Task
Phase 3 Chunk 2 — Core budget modules (tasks 2.0-2.5)

## Outcome: COMPLETE

All 7 tasks delivered with 6 atomic commits. 59 tests passing, 0 regressions.

## Deliverables

### New files (7)
- `packages/manta-cli/src/config/budget-config.ts` — `loadBudgetConfig()` + `ResolvedBudgetConfig`
- `packages/manta-cli/tests/config/budget-config.test.ts` — 9 tests
- `packages/manta-cli/src/budget/cost-estimator.ts` — `estimateCost()` pure function
- `packages/manta-cli/tests/budget/cost-estimator.test.ts` — 7 tests
- `packages/manta-cli/src/budget/auto-downgrade.ts` — `computeDowngradeOptions()`
- `packages/manta-cli/tests/budget/auto-downgrade.test.ts` — 7 tests
- `packages/manta-cli/src/budget/pre-spawn-gate.ts` — `runPreSpawnGate()` seven-step gate
- `packages/manta-cli/tests/budget/pre-spawn-gate.test.ts` — 9 tests

### Modified files (2)
- `packages/manta-cli/src/commands/cast.ts` — PreSpawnGate wiring + post-cast settlement
- `packages/manta-cli/src/bin/manta.ts` — 4 new CLI flags

## Key design decisions
- Step 4 (per-cast budget check) removed from PreSpawnGate — existing L1/L2 gate in cast.ts handles it with correct parameters before gate is called
- Plan test case for `$4 remaining → recon-swarm × 3 = $4.50` was arithmetically wrong (marked viable at $4.50 > $4.00) — corrected to expect `viable: false`
- `exactOptionalPropertyTypes` requires explicit `| undefined` in optional interface properties

## Surprising insight
The PreSpawnGate's Step 4 (per-cast budget check) duplicates the existing cumulative budget gate in cast.ts lines 194-203. However, the two checks use different source values: the gate uses BudgetConfig defaults ($15 per cast) while cast.ts uses CLI-specified values (sometimes $5 in tests). This mismatch caused all 4 forking-realities tests to fail. The correct design is: L1/L2 remains in cast.ts (which has the actual CLI values), gate handles only L3 (daily cap) + charge system.
