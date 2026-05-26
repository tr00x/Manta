# Phase 3 — Charge System + Multi-Layer Budgets + Cooldowns

**Status:** Under review
**Spec ref:** Sec 6.4 (Manta Charge), Sec 9.4 (Cost runaway), Sec 6.7 (Refresher Orb), Sec 15.1 (Phase 3)
**Research:** `docs/research/phase-3-{budget-codepath-map,charge-persistence,budget-layers}.md`
**Build strategy:** JSON+lockfile persistence (research concluded SQLite is unjustified for ~200-byte state). No forking-realities for persistence — research was conclusive. Forking-realities reserved for implementation alternatives in Chunk 2.

---

## Chunk 1 — Charge & Budget Stores + Config (foundation)

### Task 1.1 — BusPaths extension for charges + daily-spend + config

**Purpose:** Add path helpers for new state files.
**Files:**
- Modify `packages/manta-bus/src/state/paths.ts` — add `charges`, `chargesLog`, `dailySpend`, `configDir`, `budgetConfig`
- Modify `packages/manta-bus/tests/state/paths.test.ts` — add assertions for new paths

**Paths to add:**
```typescript
charges: join(root, '.manta', 'state', 'charges.json'),
chargesLog: join(root, '.manta', 'state', 'charges.log'),
dailySpend: join(root, '.manta', 'state', 'daily-spend.json'),
configDir: join(root, '.manta', 'config'),
budgetConfig: join(root, '.manta', 'config', 'budget.json'),
```

**Test:** 5 new assertions (path includes expected segments).
**Acceptance:** `pnpm --filter @manta/bus test` green.

---

### Task 1.2 — Charge schemas + mode cost table

**Purpose:** Zod schemas for charge state and audit events. Mode-to-charge-cost map.
**Files:**
- Modify `packages/manta-bus/src/schema.ts` — add `ChargeStateSchema`, `ChargeEventSchema`, `ChargeEventTypeSchema`, `CHARGE_COST_BY_MODE`
- Modify `packages/manta-bus/src/index.ts` — re-export new schemas and types

**ChargeStateSchema:**
```typescript
ChargeStateSchema = z.object({
  version: z.literal(1),
  current: z.number().int(),          // [-1, 5]
  max: z.number().int().positive(),   // 5
  min: z.number().int(),              // -1
  last_idle_recovery_at: z.number().nonnegative(),
  cooldown_until: z.number().nullable(),
  total_successes: z.number().int().nonnegative(),
  total_failures: z.number().int().nonnegative(),
  total_casts: z.number().int().nonnegative(),
}).strict();
```

**ChargeEventTypeSchema:**
```typescript
z.enum(['cast_debit', 'cast_success', 'cast_fail', 'cast_neutral', 'idle_recovery', 'manual_refresh'])
```

**CHARGE_COST_BY_MODE:** `Record<Mode, number>` from spec Sec 2:
```typescript
{ 'recon-swarm': 1, 'forking-realities': 2, 'pair-programming': 1, ... }
```

**Test:** Schema parse/reject tests (valid state, invalid current out of range, valid event, invalid event type).
**Acceptance:** Schemas importable from `@manta/bus`, types inferred correctly.

---

### Task 1.3 — ChargeStore class

**Purpose:** Read/write charge state with audit trail. Core Phase 3 module.
**Files:**
- Create `packages/manta-bus/src/state/charges.ts`
- Create `packages/manta-bus/tests/state/charges.test.ts`
- Modify `packages/manta-bus/src/state/index.ts` — re-export

**ChargeStore API:**
```typescript
class ChargeStore {
  constructor(paths: BusPaths, clock: Clock);
  async read(): Promise<ChargeState>;
  async debit(mode: Mode, castId: string): Promise<ChargeState>;   // current -= cost
  async credit(reason: ChargeEventType, castId: string | null): Promise<ChargeState>;
  async applyIdleRecovery(): Promise<ChargeState | null>;  // null = no recovery needed
  async refresh(): Promise<ChargeState>;  // reset cooldown, set current=initial
  async checkCooldown(): Promise<{ inCooldown: boolean; until: number | null }>;
}
```

**Internals:**
- Uses `atomicMutateJson` for state mutations (same as Registry, LocksStore, etc.)
- Audit trail via `auditAppend` callback writing JSONL to `paths.chargesLog`
- `debit()`: validates `current >= cost`, enforces overdraft-only-wave-1 rule, triggers 24h cooldown if `current < 0 && reason === 'cast_fail'`
- `credit()`: caps at `max`
- `applyIdleRecovery()`: checks `clock.now() - last_idle_recovery_at >= 30min`, returns `null` if too soon
- Default state: `{ version: 1, current: 3, max: 5, min: -1, ... }`

**Tests (TDD, ~15 tests):**
1. `read()` returns default state on empty file
2. `debit()` reduces current by mode cost
3. `debit()` rejects when charges insufficient (non-overdraft)
4. `debit()` allows overdraft to -1
5. `debit()` rejects overdraft for cost > 1 modes
6. `debit()` during cooldown rejects
7. `credit('cast_success')` increments, capped at max
8. `credit('cast_fail')` decrements
9. `credit('cast_fail')` on overdraft triggers 24h cooldown
10. `applyIdleRecovery()` adds +1 after 30min
11. `applyIdleRecovery()` caps at max
12. `applyIdleRecovery()` returns null when too soon
13. `refresh()` clears cooldown, sets current to initial
14. Audit trail: each mutation appends a line to chargesLog
15. Crash recovery: audit log has entry even if state file missing

**Acceptance:** 15+ tests green, 95%+ coverage on charges.ts.

---

### Task 1.4 — DailySpendLedger

**Purpose:** Track daily cumulative spend for daily cap enforcement.
**Files:**
- Create `packages/manta-bus/src/state/daily-spend.ts`
- Create `packages/manta-bus/tests/state/daily-spend.test.ts`
- Modify `packages/manta-bus/src/state/index.ts` — re-export

**DailySpendLedger API:**
```typescript
class DailySpendLedger {
  constructor(paths: BusPaths, clock: Clock);
  async read(): Promise<DailySpend>;
  async record(entry: DailySpendEntry): Promise<DailySpend>;
  async todaySpent(): Promise<number>;   // shorthand for read().spent_usd (auto-resets on day change)
}
```

**Auto-reset:** When `read()` is called and stored `date !== today`, reset to `{ date: today, spent_usd: 0, entries: [] }`. Uses `Intl.DateTimeFormat` for local date.

**DailySpendEntry:**
```typescript
{ cast_id: string; mode: Mode; clone_count: number; estimated_cost_usd: number; cost_type: 'estimate' | 'actual'; started_at: number; }
```

**Tests (TDD, ~8 tests):**
1. `read()` returns empty ledger on first call
2. `record()` adds entry and updates spent_usd
3. `todaySpent()` returns cumulative
4. Auto-reset on day change (mock clock)
5. Multiple entries accumulate
6. Concurrent writes (atomic JSON)

**Acceptance:** Tests green, coverage > 90%.

---

### Task 1.5 — BudgetConfig loader

**Purpose:** Load/save `.manta/config/budget.json` with defaults.
**Files:**
- Create `packages/manta-cli/src/config/budget-config.ts`
- Create `packages/manta-cli/tests/config/budget-config.test.ts`

**BudgetConfig interface:**
```typescript
interface BudgetConfig {
  per_cast_usd: number;              // default 15
  per_clone_usd: number | 'auto';   // default 'auto'
  daily_cap_usd: number;            // default 50
  cost_estimates: Record<Mode, number>;  // per-mode per-clone estimates
  auto_downgrade: { enabled: boolean; confirm: boolean; min_clones: number; };
  charges: { initial: number; max: number; min: number; idle_recovery_minutes: number; cooldown_hours: number; };
}
```

**loadBudgetConfig(configPath):** Read file if exists, merge with defaults, validate with Zod.
**saveBudgetConfig(configPath, config):** Write JSON.

**Tests (TDD, ~6 tests):**
1. Returns defaults when file missing
2. Merges partial config with defaults
3. Rejects invalid values
4. `saveBudgetConfig` round-trips

**Acceptance:** Tests green.

---

### Task 1.6 — BusContext extension + store wiring

**Purpose:** Wire ChargeStore and DailySpendLedger into BusContext.
**Files:**
- Modify `packages/manta-bus/src/context.ts` — add `charges: ChargeStore`, `dailySpend: DailySpendLedger`
- Modify `packages/manta-cli/src/runtime.ts` — construct stores and pass to context
- Update any tests that construct BusContext manually

**Acceptance:** Build green, existing tests pass, new stores accessible via `runtime.ctx.charges` and `runtime.ctx.dailySpend`.

---

### Task 1.7 — Full workspace test sweep + Chunk 1 docs

**Purpose:** Verify all packages build and test clean. Write architecture note.
**Files:**
- Modify `packages/manta-bus/ARCHITECTURE.md` — add ChargeStore and DailySpendLedger sections
- Modify `packages/manta-cli/ARCHITECTURE.md` — add BudgetConfig section
- Run `pnpm -r build && pnpm -r test && pnpm -r lint`

**Acceptance:** Zero failures across all 5+ packages.

---

## Chunk 2 — Pre-Spawn Gate + CLI Commands + Integration

### Task 2.1 — CostEstimator

**Purpose:** Estimate cast cost from mode + clone count + config.
**Files:**
- Create `packages/manta-cli/src/budget/cost-estimator.ts`
- Create `packages/manta-cli/tests/budget/cost-estimator.test.ts`

**API:**
```typescript
function estimateCastCost(mode: Mode, cloneCount: number, config: BudgetConfig): CostEstimate;
interface CostEstimate {
  per_clone_usd: number;
  total_usd: number;
  charge_cost: number;
}
```

**Tests (TDD, ~5 tests):**
1. recon-swarm × 3 = 3 × $1.50 = $4.50
2. forking-realities × 2 = 2 × $3.00 = $6.00
3. Uses config overrides when present
4. charge_cost matches CHARGE_COST_BY_MODE

**Acceptance:** Tests green.

---

### Task 2.2 — PreSpawnGate (charge + budget + daily cap composition)

**Purpose:** Orchestrate the full pre-spawn validation sequence.
**Files:**
- Create `packages/manta-cli/src/budget/pre-spawn-gate.ts`
- Create `packages/manta-cli/tests/budget/pre-spawn-gate.test.ts`

**API:**
```typescript
interface GateResult {
  allowed: boolean;
  reason?: string;  // human-readable denial reason
  estimate: CostEstimate;
  daily_remaining_usd: number;
  charges_after: number;
}
async function checkPreSpawnGate(opts: {
  mode: Mode; cloneCount: number; config: BudgetConfig;
  charges: ChargeStore; dailySpend: DailySpendLedger;
}): Promise<GateResult>;
```

**Gate sequence** (from research):
1. Charge check: `charges.current >= CHARGE_COST_BY_MODE[mode]`
2. Overdraft restriction: if `current < 0`, only cost ≤ 1
3. Cooldown check: `charges.checkCooldown()`
4. Cost estimation
5. Per-cast budget check (existing cumulative gate)
6. Daily cap check: `todaySpent() + estimate <= daily_cap`

**Tests (TDD, ~10 tests):**
1. All checks pass → allowed
2. Insufficient charges → denied
3. In cooldown → denied
4. Overdraft + expensive mode → denied
5. Daily cap exceeded → denied
6. Per-cast budget exceeded → denied
7. Edge: charges exactly equal to cost → allowed
8. Edge: daily spend exactly at cap → denied

**Acceptance:** Tests green, 95%+ coverage.

---

### Task 2.3 — AutoDowngradeAdvisor

**Purpose:** When daily cap exceeded, compute viable alternatives.
**Files:**
- Create `packages/manta-cli/src/budget/auto-downgrade.ts`
- Create `packages/manta-cli/tests/budget/auto-downgrade.test.ts`

**API:**
```typescript
interface DowngradeOption {
  clone_count: number;
  mode: Mode;
  estimated_cost_usd: number;
  label: string;
}
function computeDowngradeOptions(opts: {
  mode: Mode; requested_clones: number; daily_remaining_usd: number;
  config: BudgetConfig;
}): DowngradeOption[];
```

**Logic:** Try N-1, N-2, ..., min_clones. For each, check if estimated cost fits remaining budget.

**Tests (TDD, ~5 tests):**
1. No options if budget too low for even 1 clone
2. Reduces N until cost fits
3. Respects min_clones
4. Returns empty if mode cost exceeds remaining per single clone

**Acceptance:** Tests green.

---

### Task 2.4 — Wire PreSpawnGate into cast.ts + --dry-run flag

**Purpose:** Integrate the gate into the cast command. Add --dry-run.
**Files:**
- Modify `packages/manta-cli/src/commands/cast.ts` — insert gate before spawn loop
- Modify `packages/manta-cli/src/bin/manta.ts` — add `--dry-run`, `--daily-cap-usd`, `--force`, `--no-charge-check` flags
- Modify `packages/manta-cli/tests/commands/cast.test.ts` — add gate integration tests

**Changes to `runCastCommand`:**
1. After mode validation, before MCP preflight:
   - Load BudgetConfig
   - Call `checkPreSpawnGate()`
   - If denied and not `--force`: print reason, exit
   - If denied and daily cap: call `computeDowngradeOptions()`, present to user
   - If `--dry-run`: print cost preview (from research Sec 5.3 format), exit 0
2. After cast completes:
   - `charges.credit(outcome, castId)` (success/fail/neutral based on death_reasons)
   - `dailySpend.record(entry)`

**Outcome classification:** Map clone death_reasons to cast outcome:
- All clones delivered deliverables → `cast_success` → `+1 charge`
- Any clone died from heartbeat/TTL/budget with no output → `cast_fail` → `-1 charge`
- Manual abort / neutral drop → `cast_neutral` → `0`

**Tests (TDD, ~8 tests):**
1. Gate pass → clones spawn (existing behavior)
2. Gate deny (charges) → error, no spawn
3. `--dry-run` → cost preview printed, exit 0
4. `--force` → gate bypassed
5. `--no-charge-check` → charge check skipped
6. Post-cast settlement: success increments charges
7. Post-cast settlement: fail decrements charges

**Acceptance:** All cast tests green, existing tests still pass.

---

### Task 2.5 — `manta cost` command

**Purpose:** Show daily/weekly spend summary.
**Files:**
- Create `packages/manta-cli/src/commands/cost.ts`
- Create `packages/manta-cli/tests/commands/cost.test.ts`
- Modify `packages/manta-cli/src/bin/manta.ts` — register command

**API:** `manta cost [period]` where period = `day` (default) | `week`.

**Output format:** Per research Sec 5.2 (progress bar, cast list, remaining).

**Tests (TDD, ~4 tests):**
1. Empty ledger → $0.00 / $50.00
2. With entries → correct totals
3. Week period → per-day breakdown (from multiple daily-spend files)

**Acceptance:** Tests green.

---

### Task 2.6 — `manta charges` command

**Purpose:** Show charge system state and mode availability.
**Files:**
- Create `packages/manta-cli/src/commands/charges.ts`
- Create `packages/manta-cli/tests/commands/charges.test.ts`
- Modify `packages/manta-cli/src/bin/manta.ts` — register command

**Output format:** Per research Sec 5.2 (charges/max, state, mode availability grid).

**Tests (TDD, ~4 tests):**
1. Default state → 3/5, all modes available
2. Overdraft → warning, restricted modes
3. Cooldown → blocked message

**Acceptance:** Tests green.

---

### Task 2.7 — `manta refresh` command

**Purpose:** Reset cooldown (spec Sec 6.7). Double confirm.
**Files:**
- Create `packages/manta-cli/src/commands/refresh.ts`
- Create `packages/manta-cli/tests/commands/refresh.test.ts`
- Modify `packages/manta-cli/src/bin/manta.ts` — register command

**Double confirm:** Two sequential stdin prompts (type "refresh" twice).
**Non-TTY:** Error exit, not hang.

**Tests (TDD, ~4 tests):**
1. Not in cooldown → "No cooldown active"
2. In cooldown + confirmed → clears cooldown
3. In cooldown + cancelled → no change

**Acceptance:** Tests green.

---

### Task 2.8 — `manta limit` command

**Purpose:** Read/write budget config.
**Files:**
- Create `packages/manta-cli/src/commands/limit.ts`
- Create `packages/manta-cli/tests/commands/limit.test.ts`
- Modify `packages/manta-cli/src/bin/manta.ts` — register command

**Subcommands:**
- `manta limit get [key]` — show config (all or specific key)
- `manta limit set <key> <value>` — update config key

**Tests (TDD, ~5 tests):**
1. `get` with no config → defaults
2. `set daily_cap_usd 100` → updates file
3. `get` after set → reflects change
4. Invalid key → error

**Acceptance:** Tests green.

---

### Task 2.9 — Passive recovery in orchestrator

**Purpose:** Check for idle recovery during runCycle.
**Files:**
- Modify `packages/manta-orchestrator/src/orchestrator.ts` — add passive recovery check
- Modify `packages/manta-orchestrator/tests/orchestrator.test.ts` — add recovery tests

**Logic (in `runCycle`):**
```typescript
const activeClones = detected.filter(c => c.state !== 'DEAD');
if (activeClones.length === 0) {
  await this.ctx.charges?.applyIdleRecovery();
}
```

Optional `charges` field on OrchestratorOptions (same pattern as `timeline`).

**Tests (TDD, ~3 tests):**
1. No active clones + 30min elapsed → recovery applied
2. Active clones → no recovery
3. Less than 30min → no recovery

**Acceptance:** Orchestrator tests green.

---

### Task 2.10 — Full workspace sweep + user docs + e2e smoke

**Purpose:** Final integration verification.
**Files:**
- Create `docs/user/charge-system.md` — user-facing guide
- Modify `docs/user/getting-started.md` — mention charge system
- Run `pnpm -r build && pnpm -r test && pnpm -r lint`

**E2e smoke (optional, env-gated):**
- `manta cast recon-swarm --dry-run -n 2` → cost preview, exit 0
- `manta charges` → shows default state
- `manta cost` → shows $0.00

**Acceptance:** Zero failures workspace-wide. Docs committed.

---

## Summary

| Chunk | Tasks | Est. new code | Key modules |
|---|---|---|---|
| 1 | 1.1–1.7 | ~500 lines + ~300 test lines | ChargeStore, DailySpendLedger, BudgetConfig, BusPaths, schemas |
| 2 | 2.1–2.10 | ~600 lines + ~400 test lines | PreSpawnGate, CostEstimator, AutoDowngradeAdvisor, 5 CLI commands |
| **Total** | **17 tasks** | **~1100 + ~700 tests** | Full charge system end-to-end |

**Build strategy:** Chunk 1 → cast clones for implementation. Chunk 2 → cast clones for implementation. Plan reviewer per chunk before execution.
