# Phase 3 — Charge System + Multi-Layer Budget Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Production-grade charge system (frequency limiter), multi-layer budget enforcement (cost limiter), and budget/charge CLI surface. After this plan ships, `manta cast` checks charges and daily budget before spawning, deducts charges on cast start, settles them on completion, tracks daily spend, and exposes `/manta cost`, `/manta charges`, `/manta refresh`, and `/manta limit` commands for visibility and control. The `--dry-run` flag previews cost and resource checks without spawning.

**Architecture:** Two chunks. Chunk 1 builds the persistent data layer: `ChargeStore` (charges.json state + charges.log audit trail), `DailySpendLedger` (daily-spend.json with calendar-day reset), `BudgetConfig` loader (.manta/config/budget.json with CLI override precedence), the `MODE_CHARGE_COST` constant, `CastOutcomeClassifier`, `BusPaths` extension, `BusContext` wiring, and full TDD test suites. Chunk 2 integrates them: `CostEstimator`, `PreSpawnGate` (seven-step pre-spawn sequence from spec Sec 9.4), `AutoDowngradeAdvisor`, post-cast settlement in `cast.ts`, passive recovery (on-demand at pre-spawn), four new CLI commands, four new `manta cast` flags, integration tests, and an e2e smoke test.

**Tech Stack:** TypeScript 5.x strict, Node 20+, `zod`, `vitest`, the existing `@manta/bus` `atomicMutateJson`/`atomicReadJson`/`appendJsonLine`/`Clock` primitives. `proper-lockfile` for mutex (already a dependency). Zero new runtime dependencies. JSON+lockfile persistence (not SQLite) — Clone B's research was conclusive: zero new deps, identical concurrency model to 5 existing stores, separate audit trail for crash recovery.

**Persistence decision: JSON+lockfile.** Spec Sec 15 originally called for forking-realities to evaluate SQLite vs JSON+lockfile. Clone B's research (docs/research/phase-3-charge-persistence.md) conclusively rules out SQLite: (1) it introduces a native addon dependency (better-sqlite3, ~2.5 MB, node-gyp/platform matrix); (2) the write rate is ~1/minute for a 200-byte JSON object — SQLite's concurrency advantages are irrelevant; (3) the existing bus uses atomicMutateJson for 5 stores with the same invariants; (4) a separate charges.log file provides crash recovery that SQLite bundles into a single-point-of-failure. The forking-realities evaluation is therefore unnecessary — we proceed directly with JSON+lockfile.

---

## Why two chunks (and not one, and not four)

The data layer (Chunk 1) and the integration layer (Chunk 2) have a strict dependency: every Chunk 2 module (`PreSpawnGate`, `CostEstimator`, settlement, CLI commands) consumes `ChargeStore`, `DailySpendLedger`, or `BudgetConfig` from Chunk 1. Merging them into one chunk would produce a ~2000-line review surface — above the ≤1000-line per-chunk target. Splitting further (4 chunks) would over-fragment: the `PreSpawnGate` composition in Chunk 2 reads from all three stores and writes to two of them; separating the gate from its stores would force either forward-reference stubs or a third chunk of pure wiring. Two chunks gives each reviewer a coherent vertical slice: "can I persist charge/spend/config state correctly?" (Chunk 1) and "does the cast lifecycle correctly use that state?" (Chunk 2).

---

## Scope

**In-scope (Phase 3):**
- `ChargeStore` class in `@manta/bus` — atomic JSON read/write for `.manta/state/charges.json`, append-only JSONL audit trail at `.manta/state/charges.log`. Methods: `read()`, `deductForCast()`, `creditSuccess()`, `creditFail()`, `creditNeutral()`, `applyPassiveRecovery()`, `triggerCooldown()`, `clearCooldown()`, `reset()`.
- `DailySpendLedger` class in `@manta/bus` — atomic JSON for `.manta/state/daily-spend.json` with calendar-day auto-reset. Methods: `read()`, `recordCastStart()`, `getRemaining()`.
- `BudgetConfig` loader in `@manta/cli` — reads `.manta/config/budget.json`, merges with CLI flags, returns typed config with defaults. Pattern follows `loadScoringConfig` in `@manta/orchestrator`.
- `MODE_CHARGE_COST` constant — mode-to-charge-cost mapping from spec Sec 2/6.4 table.
- `CastOutcomeClassifier` — pure function: `CloneRecord[] → 'success' | 'fail' | 'neutral'`.
- `CostEstimator` — computes estimated USD cost for a mode+N combination from `BudgetConfig.cost_estimates`.
- `PreSpawnGate` — seven-step pre-spawn check sequence (charge check → cost estimation → per-cast budget → daily cap → auto-downgrade → dry-run output → commit deductions).
- `AutoDowngradeAdvisor` — given budget shortfall, computes viable downgrade options (reduce N, cheaper mode).
- Post-cast settlement in `cast.ts` — after tick loop + reap + merge-review, classify outcome, adjust charges, update daily spend.
- Passive recovery — on-demand at pre-spawn: compute idle slots since last activity, credit charges.
- `--dry-run` flag on `manta cast` — runs full pre-spawn gate, prints cost preview, exits without spawning.
- `--daily-cap-usd`, `--force`, `--no-charge-check` flags on `manta cast`.
- `manta cost [period]` — daily/weekly spend summary.
- `manta charges` — charge system state display.
- `manta refresh` — cooldown reset with double-confirm.
- `manta limit [get|set]` — budget config read/write.
- `BusPaths` extension for charges/chargesLog/dailySpend paths.
- `BusContext` extension with `charges: ChargeStore` and `dailySpend: DailySpendLedger`.
- Zod schemas for all new on-disk formats.
- `CliErrorKind` extension with `'budget_gate_failed'`.
- Integration + e2e tests.

**Out of scope (deferred):**
- Actual token counting (Claude Code `--print` does not expose cost data) — Phase 3 ships with estimates; `cost_type: 'estimate' | 'actual'` field tracks accuracy for future backfill.
- Smart context distillation (spec Sec 9 punkt 2) — separate concern, Phase 5+.
- Daemon-mode passive recovery (background timer) — Phase 5+ when long-running daemon exists. Phase 3 uses on-demand recovery at cast-start.
- Phantom-lance recursive charge math — Phase 8 (Aghs-gated).
- Combo/auto mode charge calculation — deferred until those modes are implemented (Phase 4+).
- Changes to `@manta/snapshot` `BudgetSchema` — fields exist, meaning unchanged; runtime accounting fills `dollarsUsed` in Phase 5+ when actual data is available.

---

## Spec & research alignment

Source-of-truth design: `docs/superpowers/specs/2026-05-06-manta-pattern-design.md`.

| Spec anchor | Demand | This plan's response |
|---|---|---|
| Sec 2 table | Mode charge costs (1–3 per mode) | `MODE_CHARGE_COST` constant in `@manta/bus` schema (Task 1.3). |
| Sec 6.4 | Charge persistence + recovery + bankruptcy | `ChargeStore` with JSON+lockfile (Chunk 1 Task 1.5). Passive recovery on-demand (Chunk 2 Task 2.3). Bankruptcy → 24h cooldown (ChargeStore.triggerCooldown). |
| Sec 6.7 | `/manta refresh` cooldown reset | `manta refresh` command (Chunk 2 Task 2.9). |
| Sec 9 punkt 4 | Multi-layer budget (cast/clone/daily) | PreSpawnGate seven-step sequence (Chunk 2 Task 2.3). Existing L1/L2 in cast.ts preserved; L3 daily cap added. |
| Sec 9 punkt 4 | Auto-downgrade | AutoDowngradeAdvisor (Chunk 2 Task 2.4). |
| Sec 9 punkt 4 | Cost preview / dry-run | `--dry-run` flag on `manta cast` (Chunk 2 Task 2.5). |
| Sec 11 line 479 | `/manta cost --period=week` | `manta cost` command (Chunk 2 Task 2.7). |
| Sec 14 | Production quality | TDD per task, ≥80% coverage, no `// TODO`, atomic commits. |
| Sec 15 Phase 3 | Charge persistence + budget multi-layer | Full implementation in 2 chunks. |
| Sec 15 Phase 3 | Build by: fork-by-manta (sqlite vs JSON) | Resolved by research — JSON+lockfile wins; forking-realities unnecessary (see persistence decision above). |

Research deliverables consulted:
- `docs/research/phase-3-budget-codepath-map.md` (Clone A) — exact file:line references for every budget touch point; lifecycle hooks for charge mutations; dependency graph.
- `docs/research/phase-3-charge-persistence.md` (Clone B) — JSON+lockfile vs SQLite comparison; ChargeState interface; write patterns; failure modes; implementation sketch.
- `docs/research/phase-3-budget-layers.md` (Clone C) — nine-chunk scope; PreSpawnGate sequence; CLI command designs; auto-downgrade UX; BudgetConfig schema; daily-spend ledger; cost estimation.

---

## Quality bar (CLAUDE.md / spec Sec 14)

- Test coverage ≥ 80% statements/branches on every new file.
- TDD per task: failing test → run → minimal impl → re-run → commit.
- No `// TODO`, `// FIXME`, `it.skip`, `test.skip` in merged code.
- Atomic conventional commits with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- No lint warnings — fix or `// Reason:` suppress.
- Plan reviewer subagent must approve each chunk before execution.
- Cross-plan field-name drift guard: every interface reference in this plan cites the exact line in the predecessor file.

---

## Reference docs

- Source-of-truth design: `docs/superpowers/specs/2026-05-06-manta-pattern-design.md` — Sec 2 (mode charge costs), Sec 6.4 (charge system), Sec 6.7 (refresh), Sec 9 punkt 4 (budget layers), Sec 11 (cost command), Sec 14 (quality), Sec 15 (Phase 3 scope).
- Predecessor plans: `docs/superpowers/plans/2026-05-08-phase-2a-forking-spawn.md` (cast manifest + spawn surface pattern this plan extends).
- Phase 3 research: `docs/research/phase-3-budget-codepath-map.md` (Clone A), `phase-3-charge-persistence.md` (Clone B), `phase-3-budget-layers.md` (Clone C).
- Project rules: `CLAUDE.md` — Quality bar (PROD only), Plan-writing discipline, Git rules.
- Pitfalls memo: `docs/internals/claude-code-pitfalls.md`.

---

## Chunks overview

1. **Chunk 1 — Data layer: ChargeStore + DailySpendLedger + BudgetConfig.** Pure additive — zero regressions to existing functionality. Adds three stores, five Zod schemas, BusPaths extension, BusContext wiring, MODE_CHARGE_COST constant, CastOutcomeClassifier. After Chunk 1, the charge/spend/config APIs exist with full tests but are not yet wired into the cast lifecycle. Ships green standalone.
2. **Chunk 2 — Integration + CLI: PreSpawnGate + commands + settlement.** Depends on Chunk 1. Wires charge/spend/config into the `manta cast` lifecycle (pre-spawn gate + post-cast settlement), adds CostEstimator, AutoDowngradeAdvisor, passive recovery, four new CLI commands, four new flags, integration tests, e2e test. After Chunk 2, the full Phase 3 charge+budget system is production-ready.

---

## Chunk 1: Data layer — ChargeStore + DailySpendLedger + BudgetConfig

**Goal of this chunk:** Persistent stores for charge state, daily spend, and budget configuration — with full APIs, Zod schemas, and TDD test suites. After Chunk 1, downstream code (Chunk 2) can `charges.read()`, `charges.deductForCast()`, `dailySpend.recordCastStart()`, `loadBudgetConfig()`, and `classifyCastOutcome()` with confidence. No cast.ts or CLI changes in this chunk.

**Files (new):**
- Create: `packages/manta-bus/tests/state/charge-store.test.ts` — schema + store unit tests (~350 LOC).
- Create: `packages/manta-bus/src/state/charge-store.ts` — `ChargeStore` class (~180 LOC).
- Create: `packages/manta-bus/tests/state/daily-spend.test.ts` — schema + store unit tests (~200 LOC).
- Create: `packages/manta-bus/src/state/daily-spend.ts` — `DailySpendLedger` class (~120 LOC).
- Create: `packages/manta-cli/src/config/budget-config.ts` — `loadBudgetConfig()` + defaults (~80 LOC).
- Create: `packages/manta-cli/tests/config/budget-config.test.ts` — loader unit tests (~120 LOC).
- Create: `packages/manta-cli/src/budget/cast-outcome.ts` — `classifyCastOutcome()` pure function (~50 LOC).
- Create: `packages/manta-cli/tests/budget/cast-outcome.test.ts` — classifier unit tests (~80 LOC).

**Files (modified):**
- Modify: `packages/manta-bus/src/schema.ts` — add `ChargeStateSchema`, `ChargeEventSchema`, `DailySpendEntrySchema`, `DailySpendStateSchema`, `BudgetConfigSchema`, `MODE_CHARGE_COST` constant, plus corresponding `export type` lines (~100 LOC added).
- Modify: `packages/manta-bus/src/state/paths.ts` — add `charges`, `chargesLog`, `dailySpend` to `BusPaths` interface and `busPaths()` function (~10 LOC added).
- Modify: `packages/manta-bus/tests/state/paths.test.ts` — add path test cases (~10 LOC added).
- Modify: `packages/manta-bus/src/tools/index.ts` — add `charges: ChargeStore` and `dailySpend: DailySpendLedger` to `BusContext` interface.
- Modify: `packages/manta-bus/src/server.ts` — construct `ChargeStore` and `DailySpendLedger` in `createBusServer`.
- Modify: `packages/manta-bus/src/index.ts` — export `ChargeStore`, `DailySpendLedger`, and new types.
- Modify: `packages/manta-cli/src/errors.ts` — add `'budget_gate_failed'` to `CliErrorKind`.

### Tasks

- [ ] **1.0: Verify workspace baseline green**

  **Purpose:** Confirm all packages build and test clean before any changes — catch pre-existing failures.

  **Steps:**
  ```bash
  pnpm -r build && pnpm -r test
  ```

  **Acceptance criteria:** All tests pass. If anything fails, STOP — Chunk 1 depends on a green workspace.

---

- [ ] **1.1: Add charge/budget Zod schemas + MODE_CHARGE_COST (failing tests first)**

  **Purpose:** Define the on-disk JSON shapes for charge state, charge events, daily spend, and budget config. Pin the mode-to-charge-cost mapping. TDD: write tests first, verify they fail.

  **Files:**
  - Create: `packages/manta-bus/tests/state/charge-store.test.ts` (schema section only — store tests come in Task 1.5)
  - Modify: `packages/manta-bus/src/schema.ts`

  **Schema definitions (target state in schema.ts):**

  The mode-to-charge-cost constant, derived from spec Sec 2 table:

  ```ts
  export const MODE_CHARGE_COST: Readonly<Record<Mode, number>> = {
    'recon-swarm': 1,
    'pair-programming': 1,
    'documentation-chase': 1,
    'forking-realities': 2,
    'test-storm': 2,
    'refactor-wave': 2,
    'bug-hunt': 2,
    'decoy': 2,
    'council': 3,
    'phantom-lance': 3,
  };
  ```

  Charge state (on-disk `.manta/state/charges.json`):

  ```ts
  export const ChargeStateSchema = z
    .object({
      version: z.literal(1),
      current_charges: z.number().int(),
      charges_max: z.number().int().positive(),
      charges_min: z.number().int(),
      last_idle_recovery_at: z.number().int().nonnegative(),
      last_cast_ended_at: z.number().int().nonnegative(),
      cooldown_until: z.number().int().nonnegative().nullable(),
      total_successes: z.number().int().nonnegative(),
      total_failures: z.number().int().nonnegative(),
      total_casts: z.number().int().nonnegative(),
    })
    .strict();
  ```

  Charge event (audit trail, one JSONL line in `.manta/state/charges.log`):

  ```ts
  export const ChargeEventTypeSchema = z.enum([
    'cast_start',
    'cast_success',
    'cast_fail',
    'cast_neutral',
    'idle_recovery',
    'manual_refresh',
    'cooldown_triggered',
    'cooldown_cleared',
  ]);

  export const ChargeEventSchema = z
    .object({
      ts: z.number().int().nonnegative(),
      type: ChargeEventTypeSchema,
      delta: z.number().int(),
      cast_id: z.string().nullable(),
      mode: ModeSchema.nullable(),
      cost: z.number().int().nonnegative().optional(),
      prev_charges: z.number().int(),
      next_charges: z.number().int(),
      reason: z.string().optional(),
    })
    .strict();
  ```

  Daily spend entry + state (on-disk `.manta/state/daily-spend.json`):

  ```ts
  export const DailySpendEntrySchema = z
    .object({
      cast_id: z.string(),
      mode: ModeSchema,
      clone_count: z.number().int().positive(),
      estimated_cost_usd: z.number().nonnegative(),
      cost_type: z.enum(['estimate', 'actual']),
      started_at: z.number().int().nonnegative(),
    })
    .strict();

  export const DailySpendStateSchema = z
    .object({
      version: z.literal(1),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      spent_usd: z.number().nonnegative(),
      entries: z.array(DailySpendEntrySchema),
    })
    .strict();
  ```

  Budget config (on-disk `.manta/config/budget.json`). Uses `.partial()` because all fields have defaults provided by the loader — the file may contain any subset:

  ```ts
  export const BudgetConfigSchema = z
    .object({
      per_cast_usd: z.number().positive(),
      per_clone_usd: z.union([z.number().positive(), z.literal('auto')]),
      daily_cap_usd: z.number().positive(),
      cost_estimates: z.record(ModeSchema, z.number().nonnegative()),
      auto_downgrade: z
        .object({
          enabled: z.boolean(),
          confirm: z.boolean(),
          min_clones: z.number().int().positive(),
        })
        .partial()
        .strict(),
      charges: z
        .object({
          initial: z.number().int().nonnegative(),
          max: z.number().int().positive(),
          min: z.number().int(),
          idle_recovery_minutes: z.number().int().positive(),
          cooldown_hours: z.number().int().positive(),
        })
        .partial()
        .strict(),
    })
    .partial()
    .strict();
  ```

  Export all inferred types:

  ```ts
  export type ChargeState = z.infer<typeof ChargeStateSchema>;
  export type ChargeEvent = z.infer<typeof ChargeEventSchema>;
  export type ChargeEventType = z.infer<typeof ChargeEventTypeSchema>;
  export type DailySpendEntry = z.infer<typeof DailySpendEntrySchema>;
  export type DailySpendState = z.infer<typeof DailySpendStateSchema>;
  export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;
  ```

  **Schema test cases (charge-store.test.ts schema section):**
  - `ChargeStateSchema` accepts valid state with current=-1 (overdraft allowed)
  - `ChargeStateSchema` rejects current_charges as float (must be int)
  - `ChargeStateSchema` rejects extra keys (strict)
  - `ChargeEventSchema` accepts all 8 event types
  - `ChargeEventSchema` accepts nullable cast_id (for idle_recovery)
  - `DailySpendStateSchema` accepts valid daily state
  - `DailySpendStateSchema` rejects malformed date string
  - `BudgetConfigSchema` accepts empty object (all fields optional)
  - `BudgetConfigSchema` accepts per_clone_usd: 'auto'
  - `BudgetConfigSchema` rejects per_clone_usd: 0 (must be positive)
  - `MODE_CHARGE_COST` maps all 10 modes, values match spec

  Run: `pnpm --filter @manta/bus test -- tests/state/charge-store.test.ts`
  Expected: all tests fail (schemas not exported yet).

---

- [ ] **1.2: Verify schema tests fail**

  **Purpose:** TDD gate — confirm tests fail before implementation.

  Run: `pnpm --filter @manta/bus test -- tests/state/charge-store.test.ts`
  Expected: compilation/import errors — schemas don't exist yet.

---

- [ ] **1.3: Implement schemas in schema.ts**

  **Purpose:** Add all schema definitions and MODE_CHARGE_COST to `packages/manta-bus/src/schema.ts`.

  **File:** `packages/manta-bus/src/schema.ts` — append after the existing `CreateCastInputSchema` block (currently ends around line ~270). Add all schemas from Task 1.1 plus the `MODE_CHARGE_COST` constant. Add type exports at the bottom alongside existing type exports (around line ~297).

  **Verify imports:** `ModeSchema` is already defined at `schema.ts:12-23` and is used by `ChargeEventSchema` and `DailySpendEntrySchema`. No new imports needed.

  Run: `pnpm --filter @manta/bus test -- tests/state/charge-store.test.ts`
  Expected: all schema tests pass.

  Run: `pnpm --filter @manta/bus build`
  Expected: clean TypeScript build.

  Commit:
  ```
  feat(bus): add charge/budget/daily-spend Zod schemas + MODE_CHARGE_COST

  Phase 3 Chunk 1 — defines on-disk JSON shapes for charge state,
  charge audit events, daily spend tracking, and budget configuration.
  MODE_CHARGE_COST maps each mode to its spec Sec 2 charge cost.
  All schemas use snake_case fields (bus convention).

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

---

- [ ] **1.4: Extend BusPaths for charge/daily-spend paths**

  **Purpose:** Add file paths for charges.json, charges.log, and daily-spend.json to `BusPaths`.

  **File:** `packages/manta-bus/src/state/paths.ts`

  Add to `BusPaths` interface (currently at `paths.ts:4-16`):
  ```ts
  readonly charges: string;
  readonly chargesLog: string;
  readonly dailySpend: string;
  ```

  Add to `busPaths()` return object (currently at `paths.ts:18-48`):
  ```ts
  charges: path.join(stateDir, 'charges.json'),
  chargesLog: path.join(stateDir, 'charges.log'),
  dailySpend: path.join(stateDir, 'daily-spend.json'),
  ```

  **File:** `packages/manta-bus/tests/state/paths.test.ts` — add test cases:
  ```ts
  it('busPaths.charges points to stateDir/charges.json', () => {
    const p = busPaths('/tmp/repo');
    expect(p.charges).toBe('/tmp/repo/.manta/state/charges.json');
  });

  it('busPaths.chargesLog points to stateDir/charges.log', () => {
    const p = busPaths('/tmp/repo');
    expect(p.chargesLog).toBe('/tmp/repo/.manta/state/charges.log');
  });

  it('busPaths.dailySpend points to stateDir/daily-spend.json', () => {
    const p = busPaths('/tmp/repo');
    expect(p.dailySpend).toBe('/tmp/repo/.manta/state/daily-spend.json');
  });
  ```

  Run: `pnpm --filter @manta/bus test -- tests/state/paths.test.ts`
  Expected: all cases green.

  Commit:
  ```
  feat(bus): extend BusPaths with charges + chargesLog + dailySpend paths

  Phase 3 Chunk 1 — three new path entries under .manta/state/ for the
  charge state file, charge audit log, and daily spend tracker.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

---

- [ ] **1.5: ChargeStore — tests (failing) + implementation**

  **Purpose:** Persistent store for charge state + audit trail. Follows the same `atomicMutateJson`/`atomicReadJson`/`appendJsonLine` pattern as `Registry`, `ContractsStore`, `CastsStore`.

  **Files:**
  - Create: `packages/manta-bus/tests/state/charge-store.test.ts` (append store tests after schema tests from Task 1.1)
  - Create: `packages/manta-bus/src/state/charge-store.ts`

  **ChargeStore API:**

  ```ts
  import { atomicMutateJson, atomicReadJson, appendJsonLine } from '../atomic-fs';
  import type { Clock } from '../clock';
  import type { ChargeState, ChargeEvent, Mode } from '../schema';
  import { ChargeStateSchema, MODE_CHARGE_COST } from '../schema';
  import type { BusPaths } from './paths';

  export interface ChargeStoreConfig {
    initial: number;    // default 3
    max: number;        // default 5
    min: number;        // default -1
    idleRecoveryMinutes: number;  // default 30
    cooldownHours: number;        // default 24
  }

  export const DEFAULT_CHARGE_CONFIG: ChargeStoreConfig = {
    initial: 3,
    max: 5,
    min: -1,
    idleRecoveryMinutes: 30,
    cooldownHours: 24,
  };

  export class ChargeStore {
    constructor(
      private readonly paths: BusPaths,
      private readonly clock: Clock,
      private readonly config: ChargeStoreConfig = DEFAULT_CHARGE_CONFIG,
    ) {}

    /** Lock-free read of current charge state. */
    async read(): Promise<ChargeState> { ... }

    /**
     * Deduct charges for a cast start. Returns updated state.
     * Throws if insufficient charges or in cooldown.
     * Appends audit event to charges.log.
     */
    async deductForCast(castId: string, mode: Mode): Promise<ChargeState> { ... }

    /** Credit +1 after successful cast. */
    async creditSuccess(castId: string, mode: Mode): Promise<ChargeState> { ... }

    /** Debit -1 after failed cast. May trigger cooldown if in overdraft. */
    async creditFail(castId: string, mode: Mode): Promise<ChargeState> { ... }

    /** No charge change on neutral outcome. Logs event only. */
    async creditNeutral(castId: string, mode: Mode): Promise<ChargeState> { ... }

    /**
     * Apply pending passive recovery credits.
     * Computes idle slots since max(last_idle_recovery_at, last_cast_ended_at).
     * Each slot = +1 charge, capped at charges_max.
     * Called on-demand at pre-spawn time (not by a background timer).
     */
    async applyPassiveRecovery(): Promise<{ creditsApplied: number; state: ChargeState }> { ... }

    /**
     * Trigger 24h cooldown. Called when charges < 0 and a cast fails.
     */
    async triggerCooldown(): Promise<ChargeState> { ... }

    /**
     * Clear cooldown (/manta refresh). Resets cooldown_until to null.
     * Sets current_charges to 0 (not initial — you're starting from zero after refresh).
     */
    async clearCooldown(): Promise<ChargeState> { ... }

    /**
     * Full reset to initial state (for testing / emergency).
     */
    async reset(): Promise<ChargeState> { ... }

    /** Read the audit log. */
    async readLog(): Promise<ChargeEvent[]> { ... }
  }
  ```

  **Default factory (used by atomicMutateJson when charges.json doesn't exist):**

  ```ts
  private defaultState(): ChargeState {
    return {
      version: 1,
      current_charges: this.config.initial,
      charges_max: this.config.max,
      charges_min: this.config.min,
      last_idle_recovery_at: this.clock.now(),
      last_cast_ended_at: 0,
      cooldown_until: null,
      total_successes: 0,
      total_failures: 0,
      total_casts: 0,
    };
  }
  ```

  **Key implementation detail for deductForCast:**

  ```ts
  async deductForCast(castId: string, mode: Mode): Promise<ChargeState> {
    const cost = MODE_CHARGE_COST[mode];
    return atomicMutateJson<ChargeState>(
      this.paths.charges,
      () => this.defaultState(),
      (current) => {
        // Cooldown check
        if (current.cooldown_until != null && this.clock.now() < current.cooldown_until) {
          throw new BusConflictError(
            `Cooldown active until ${new Date(current.cooldown_until).toISOString()}. ` +
            `Use /manta refresh to clear.`
          );
        }
        // Charge sufficiency check
        if (current.current_charges < cost) {
          throw new BusConflictError(
            `Insufficient charges: have ${current.current_charges}, need ${cost} for ${mode}. ` +
            `Wait for idle recovery or /manta refresh.`
          );
        }
        // Overdraft restriction: if charges < 0, only cost ≤ 1 modes allowed
        if (current.current_charges < 0 && cost > 1) {
          throw new BusConflictError(
            `In overdraft (${current.current_charges}): only cost-1 modes allowed. ` +
            `${mode} costs ${cost}.`
          );
        }
        return {
          ...current,
          current_charges: current.current_charges - cost,
          total_casts: current.total_casts + 1,
        };
      },
      async () => {
        await appendJsonLine(this.paths.chargesLog, {
          ts: this.clock.now(),
          type: 'cast_start',
          delta: -cost,
          cast_id: castId,
          mode,
          cost,
          prev_charges: /* read from current before mutation */,
          next_charges: /* computed after mutation */,
        } satisfies ChargeEvent);
      },
    );
  }
  ```

  Note on the `prev_charges`/`next_charges` capture: the auditAppend callback runs inside the mutex after the mutator returns but before the state is flushed. The implementation must capture the pre- and post-values. Pattern: compute `prev` and `next` in the mutator, store them in closure variables accessible to auditAppend. This is the same pattern used in `state/contracts.ts` (the `sameContract` variable captured in `atomicMutateJson`'s mutator and read in the audit callback).

  **Store test cases:**
  - `read()` returns default state on fresh repo (charges_initial=3)
  - `deductForCast()` decrements current_charges by mode cost
  - `deductForCast()` appends JSONL line to charges.log
  - `deductForCast()` throws BusConflictError if charges < cost
  - `deductForCast()` allows overdraft (charges 0, cost 1 → charges -1)
  - `deductForCast()` throws if in overdraft and cost > 1
  - `deductForCast()` throws if cooldown_until is in the future
  - `creditSuccess()` increments by +1, capped at charges_max
  - `creditFail()` decrements by -1
  - `creditFail()` triggers cooldown when charges already < 0
  - `creditNeutral()` does not change current_charges (logs only)
  - `applyPassiveRecovery()` credits correct number of slots
  - `applyPassiveRecovery()` caps at charges_max
  - `applyPassiveRecovery()` returns 0 credits if < 30 min idle
  - `applyPassiveRecovery()` advances last_idle_recovery_at by exact slot multiples
  - `triggerCooldown()` sets cooldown_until to now + 24h
  - `clearCooldown()` resets cooldown_until to null, sets charges to 0
  - `reset()` returns to initial state
  - State survives restart (write, construct new store, read)
  - Concurrent deductForCast calls serialize correctly (mutex)

  **TDD flow:**
  1. Write all test cases in `charge-store.test.ts` (store section)
  2. Run: `pnpm --filter @manta/bus test -- tests/state/charge-store.test.ts` — verify store tests fail
  3. Implement `ChargeStore` in `charge-store.ts`
  4. Run again — verify all green
  5. Run full bus sweep: `pnpm --filter @manta/bus test` — no regressions

  **Acceptance criteria:** All ChargeStore tests pass. charges.json state survives restart. charges.log grows by one JSONL line per mutation. Coverage ≥ 80%.

  Commit:
  ```
  feat(bus): implement ChargeStore with JSON+lockfile persistence

  Phase 3 Chunk 1 — persistent charge state in .manta/state/charges.json
  with append-only audit trail in charges.log. Supports deduction, credit,
  passive recovery, cooldown trigger/clear. Same atomicMutateJson pattern
  as Registry/ContractsStore/CastsStore.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

---

- [ ] **1.6: DailySpendLedger — tests + implementation**

  **Purpose:** Persistent store for daily spend tracking with calendar-day auto-reset.

  **Files:**
  - Create: `packages/manta-bus/tests/state/daily-spend.test.ts`
  - Create: `packages/manta-bus/src/state/daily-spend.ts`

  **DailySpendLedger API:**

  ```ts
  import { atomicMutateJson, atomicReadJson } from '../atomic-fs';
  import type { Clock } from '../clock';
  import type { DailySpendState, DailySpendEntry, Mode } from '../schema';
  import { DailySpendStateSchema } from '../schema';
  import type { BusPaths } from './paths';

  export class DailySpendLedger {
    constructor(
      private readonly paths: BusPaths,
      private readonly clock: Clock,
    ) {}

    /** Read current daily state. Auto-resets if date has changed. */
    async read(): Promise<DailySpendState> { ... }

    /** Record a cast's estimated cost. Auto-resets if date has changed. */
    async recordCastStart(entry: Omit<DailySpendEntry, 'started_at'>): Promise<DailySpendState> { ... }

    /** Get remaining daily budget. */
    async getRemaining(dailyCapUsd: number): Promise<number> { ... }
  }
  ```

  **Calendar-day boundary:** Uses local date via `new Date().toLocaleDateString('en-CA')` which returns `YYYY-MM-DD` in the machine's timezone. This matches the user's mental model — a cast at 11:55pm and another at 12:05am are on different days.

  **Default factory:**
  ```ts
  private defaultState(): DailySpendState {
    return {
      version: 1,
      date: this.localDate(),
      spent_usd: 0,
      entries: [],
    };
  }

  private localDate(): string {
    return new Date(this.clock.now()).toLocaleDateString('en-CA');
  }
  ```

  **Auto-reset logic (in mutator):**
  ```ts
  (current) => {
    const today = this.localDate();
    if (current.date !== today) {
      // New day — reset ledger
      return {
        version: 1,
        date: today,
        spent_usd: entry.estimated_cost_usd,
        entries: [{ ...entry, started_at: this.clock.now() }],
      };
    }
    // Same day — append
    return {
      ...current,
      spent_usd: current.spent_usd + entry.estimated_cost_usd,
      entries: [...current.entries, { ...entry, started_at: this.clock.now() }],
    };
  }
  ```

  **Test cases:**
  - `read()` returns default state on fresh repo (today's date, 0 spent)
  - `recordCastStart()` adds entry and increments spent_usd
  - `recordCastStart()` auto-resets when date changes
  - `getRemaining()` returns dailyCapUsd - spent_usd
  - `getRemaining()` returns 0 (not negative) when over cap
  - Multiple entries accumulate correctly
  - State survives restart (same date)
  - Date change on read triggers reset

  **TDD flow:** Write tests → verify fail → implement → verify pass.

  **Acceptance criteria:** All DailySpendLedger tests pass. Auto-reset works on date boundary. Coverage ≥ 80%.

  Commit:
  ```
  feat(bus): implement DailySpendLedger with calendar-day auto-reset

  Phase 3 Chunk 1 — tracks cumulative daily cast spend in
  .manta/state/daily-spend.json. Resets automatically on new calendar
  day (local timezone). Uses same atomicMutateJson pattern as other
  bus state stores.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

---

- [ ] **1.7: BudgetConfig loader — tests + implementation**

  **Purpose:** Load budget configuration from `.manta/config/budget.json` with defaults fallback. Follows the `loadScoringConfig` pattern from `@manta/orchestrator` (`packages/manta-orchestrator/src/scoring.ts:28-39`).

  **Files:**
  - Create: `packages/manta-cli/src/config/budget-config.ts`
  - Create: `packages/manta-cli/tests/config/budget-config.test.ts`

  **Loader API:**

  ```ts
  import { readFile } from 'node:fs/promises';
  import { join } from 'node:path';
  import { BudgetConfigSchema } from '@manta/bus';

  export interface ResolvedBudgetConfig {
    perCastUsd: number;
    perCloneUsd: number | 'auto';
    dailyCapUsd: number;
    costEstimates: Record<string, number>;
    autoDowngrade: {
      enabled: boolean;
      confirm: boolean;
      minClones: number;
    };
    charges: {
      initial: number;
      max: number;
      min: number;
      idleRecoveryMinutes: number;
      cooldownHours: number;
    };
  }

  export const DEFAULT_BUDGET_CONFIG: ResolvedBudgetConfig = {
    perCastUsd: 15,
    perCloneUsd: 'auto',
    dailyCapUsd: 50,
    costEstimates: {
      'recon-swarm': 1.50,
      'forking-realities': 3.00,
      'pair-programming': 2.00,
      'test-storm': 3.00,
      'bug-hunt': 2.50,
      'refactor-wave': 3.00,
      'documentation-chase': 1.00,
      'phantom-lance': 4.00,
      'council': 2.00,
      'decoy': 1.50,
    },
    autoDowngrade: {
      enabled: true,
      confirm: true,
      minClones: 1,
    },
    charges: {
      initial: 3,
      max: 5,
      min: -1,
      idleRecoveryMinutes: 30,
      cooldownHours: 24,
    },
  };

  export async function loadBudgetConfig(repoRoot: string): Promise<ResolvedBudgetConfig> {
    const configPath = join(repoRoot, '.manta', 'config', 'budget.json');
    try {
      const raw = await readFile(configPath, 'utf-8');
      const parsed = BudgetConfigSchema.parse(JSON.parse(raw));
      // Deep merge parsed over defaults
      return deepMerge(DEFAULT_BUDGET_CONFIG, snakeToCamel(parsed));
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        return DEFAULT_BUDGET_CONFIG;
      }
      throw err;
    }
  }
  ```

  **Override precedence (implemented in Chunk 2 when CLI flags are wired):**
  ```
  CLI flag > config file > hardcoded default
  ```

  **Test cases:**
  - Returns defaults when config file missing
  - Parses and merges partial config (only `daily_cap_usd` set)
  - Parses full config
  - Rejects invalid config (e.g., negative daily_cap_usd)
  - Preserves unset fields from defaults
  - `per_clone_usd: 'auto'` passes through correctly

  **TDD flow:** Write tests → verify fail → implement → verify pass.

  **Acceptance criteria:** All tests pass. Default fallback works. Partial configs merge correctly.

  Commit:
  ```
  feat(cli): implement BudgetConfig loader with defaults + file merge

  Phase 3 Chunk 1 — reads .manta/config/budget.json, merges with
  hardcoded defaults. Follows loadScoringConfig pattern. CLI flag
  override wired in Chunk 2.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

---

- [ ] **1.8: CastOutcomeClassifier — tests + implementation**

  **Purpose:** Pure function that classifies a completed cast's outcome as `'success' | 'fail' | 'neutral'` based on clone death reasons and cast exit conditions. Used by post-cast settlement (Chunk 2) to determine charge adjustment.

  **Files:**
  - Create: `packages/manta-cli/src/budget/cast-outcome.ts`
  - Create: `packages/manta-cli/tests/budget/cast-outcome.test.ts`

  **API:**

  ```ts
  import type { CloneRecord } from '@manta/bus';

  export type CastOutcome = 'success' | 'fail' | 'neutral';

  export interface CastOutcomeInput {
    clones: CloneRecord[];
    budgetAborted: boolean;
  }

  /**
   * Classify a completed cast's outcome for charge settlement.
   *
   * Rules (spec Sec 6.4):
   * - FAIL: budget aborted, or any clone died from infrastructure failure
   *   (heartbeat timeout, startup grace exceeded, parent PID dead).
   * - NEUTRAL: all clones manually killed (death_reason absent or contains
   *   'manual' / 'kill').
   * - SUCCESS: at least one clone completed (state=DEAD with death_reason
   *   not matching failure patterns).
   */
  export function classifyCastOutcome(input: CastOutcomeInput): CastOutcome { ... }
  ```

  **Failure-pattern detection:** The `death_reason` strings from death-detector.ts are freeform but contain known substrings:
  - `'heartbeat'` → infrastructure failure → FAIL
  - `'startup grace'` → infrastructure failure → FAIL
  - `'parent pid'` → infrastructure failure → FAIL
  - `'budget'` → budget abort → FAIL (also caught by `budgetAborted` flag)

  If none match, the clone completed normally (graceful death via `manta.report_death`).

  **Test cases:**
  - All clones completed normally → SUCCESS
  - Budget abort triggered → FAIL
  - One clone heartbeat timeout → FAIL
  - One clone startup grace exceeded → FAIL
  - All clones manually killed → NEUTRAL
  - Mix: one success, one heartbeat timeout → FAIL (any failure = FAIL)
  - Empty clones array → NEUTRAL (edge case)
  - death_reason is undefined → treat as normal completion

  **TDD flow:** Write tests → verify fail → implement → verify pass.

  **Acceptance criteria:** All tests pass. Classifier correctly handles all death_reason patterns.

  Commit:
  ```
  feat(cli): implement CastOutcomeClassifier for charge settlement

  Phase 3 Chunk 1 — pure function classifying cast outcomes as
  success/fail/neutral based on clone death reasons and budget abort
  flag. Used by post-cast settlement in Chunk 2.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

---

- [ ] **1.9: Wire ChargeStore + DailySpendLedger into BusContext**

  **Purpose:** Make the new stores available through BusContext so cast.ts and future consumers can access them.

  **Files:**
  - Modify: `packages/manta-bus/src/tools/index.ts:16-26` — add `charges: ChargeStore` and `dailySpend: DailySpendLedger` to `BusContext`.
  - Modify: `packages/manta-bus/src/server.ts:80-99` — construct stores in `createBusServer`.
  - Modify: `packages/manta-bus/src/index.ts` — export `ChargeStore`, `DailySpendLedger`, new schema types.

  **BusContext changes (`tools/index.ts`):**

  ```diff
    import type { ContractsStore } from '../state/contracts';
    import type { CastsStore } from '../state/casts';
  + import type { ChargeStore } from '../state/charge-store';
  + import type { DailySpendLedger } from '../state/daily-spend';
    import type { EventsLog } from '../state/events';

    export interface BusContext {
      paths: BusPaths;
      clock: Clock;
      registry: Registry;
      locks: LocksStore;
      claims: ClaimsStore;
      contracts: ContractsStore;
      casts: CastsStore;
  +   charges: ChargeStore;
  +   dailySpend: DailySpendLedger;
      events: EventsLog;
      memoryWriters: MemoryWriters;
    }
  ```

  **server.ts changes:**

  ```diff
    import { CastsStore } from './state/casts';
  + import { ChargeStore } from './state/charge-store';
  + import { DailySpendLedger } from './state/daily-spend';

    const casts = new CastsStore(paths, clock);
  + const charges = new ChargeStore(paths, clock);
  + const dailySpend = new DailySpendLedger(paths, clock);
    const events = new EventsLog(paths, clock);

    const context: BusContext = {
      paths, clock, registry, locks, claims, contracts, casts,
  +   charges, dailySpend,
      events, memoryWriters,
    };
  ```

  **index.ts exports:**

  ```diff
    export { CastsStore } from './state/casts';
  + export { ChargeStore, DEFAULT_CHARGE_CONFIG } from './state/charge-store';
  + export type { ChargeStoreConfig } from './state/charge-store';
  + export { DailySpendLedger } from './state/daily-spend';
  ```

  Plus all new schema types are auto-exported via the existing `export * from './schema'` line.

  Run: `pnpm --filter @manta/bus build && pnpm --filter @manta/bus test`
  Expected: clean build, all tests green. No test currently consumes the new BusContext fields.

  Commit:
  ```
  feat(bus): wire ChargeStore + DailySpendLedger into BusContext

  Phase 3 Chunk 1 — both stores are now constructed by createBusServer
  and available via BusContext.charges / BusContext.dailySpend. Exports
  added to @manta/bus index.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

---

- [ ] **1.10: Extend CliErrorKind + full sweep**

  **Purpose:** Add `'budget_gate_failed'` to `CliErrorKind` for pre-spawn gate rejections. Then run the full cross-package test sweep to confirm zero regressions.

  **File:** `packages/manta-cli/src/errors.ts:1-7`

  ```diff
    export type CliErrorKind =
      | 'invalid_input'
      | 'cast_failed'
      | 'spawn_failed'
      | 'register_failed'
      | 'orchestrator_failed'
      | 'recovery_failed'
  -   | 'not_found';
  +   | 'not_found'
  +   | 'budget_gate_failed';
  ```

  Run:
  ```bash
  pnpm -r build && pnpm -r test
  ```

  Expected: all packages build and test green. Coverage ≥ 80% on all new files.

  Commit:
  ```
  feat(cli): add budget_gate_failed CliErrorKind + Phase 3 Chunk 1 sweep

  Phase 3 Chunk 1 complete — all data-layer stores (ChargeStore,
  DailySpendLedger, BudgetConfig) implemented and tested. New CliErrorKind
  for pre-spawn gate rejections in Chunk 2. Full sweep green.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

---

## Chunk 2: Integration + CLI — PreSpawnGate + commands + settlement

**Goal of this chunk:** Wire the data layer into the cast lifecycle and CLI. After Chunk 2, every `manta cast` passes through the seven-step PreSpawnGate (charge check → cost estimate → per-cast budget → daily cap → auto-downgrade → dry-run output → commit), every completed cast settles charges, daily spend is tracked, and four new commands give the operator visibility and control.

**Files (new):**
- Create: `packages/manta-cli/src/budget/cost-estimator.ts` — `CostEstimator` (~40 LOC).
- Create: `packages/manta-cli/tests/budget/cost-estimator.test.ts` (~60 LOC).
- Create: `packages/manta-cli/src/budget/pre-spawn-gate.ts` — `PreSpawnGate` (~200 LOC).
- Create: `packages/manta-cli/tests/budget/pre-spawn-gate.test.ts` (~300 LOC).
- Create: `packages/manta-cli/src/budget/auto-downgrade.ts` — `AutoDowngradeAdvisor` (~80 LOC).
- Create: `packages/manta-cli/tests/budget/auto-downgrade.test.ts` (~120 LOC).
- Create: `packages/manta-cli/src/commands/cost.ts` — `manta cost` (~100 LOC).
- Create: `packages/manta-cli/tests/commands/cost.test.ts` (~80 LOC).
- Create: `packages/manta-cli/src/commands/charges.ts` — `manta charges` (~80 LOC).
- Create: `packages/manta-cli/tests/commands/charges.test.ts` (~60 LOC).
- Create: `packages/manta-cli/src/commands/refresh.ts` — `manta refresh` (~60 LOC).
- Create: `packages/manta-cli/tests/commands/refresh.test.ts` (~80 LOC).
- Create: `packages/manta-cli/src/commands/limit.ts` — `manta limit` (~80 LOC).
- Create: `packages/manta-cli/tests/commands/limit.test.ts` (~80 LOC).
- Create: `packages/manta-cli/tests/budget/settlement.test.ts` — post-cast settlement integration tests (~150 LOC).
- Create: `packages/manta-e2e/tests/charge-system.e2e.test.ts` — e2e smoke test (~100 LOC).

**Files (modified):**
- Modify: `packages/manta-cli/src/commands/cast.ts` — insert PreSpawnGate before spawn, post-cast settlement after reap, pass new options.
- Modify: `packages/manta-cli/src/bin/manta.ts` — add `--dry-run`, `--daily-cap-usd`, `--force`, `--no-charge-check` flags to `cast` command; register `cost`, `charges`, `refresh`, `limit` commands.

### Tasks

- [ ] **2.0: CostEstimator — tests + implementation**

  **Purpose:** Compute estimated USD cost for a mode+N combination from BudgetConfig cost_estimates. Pure function, no I/O.

  **Files:**
  - Create: `packages/manta-cli/src/budget/cost-estimator.ts`
  - Create: `packages/manta-cli/tests/budget/cost-estimator.test.ts`

  **API:**

  ```ts
  import type { ResolvedBudgetConfig } from '../config/budget-config';
  import type { Mode } from '@manta/bus';

  export interface CostEstimate {
    mode: Mode;
    cloneCount: number;
    perCloneCostUsd: number;
    totalEstimatedUsd: number;
    perCloneBudgetUsd: number;
  }

  /**
   * Estimate cost for a cast. Uses BudgetConfig.costEstimates for per-clone
   * USD estimate per mode. Falls back to $2.00/clone if mode not in estimates.
   */
  export function estimateCost(
    mode: Mode,
    cloneCount: number,
    config: ResolvedBudgetConfig,
    perCloneBudgetOverride?: number,
  ): CostEstimate {
    const perClone = config.costEstimates[mode] ?? 2.00;
    const perCloneBudget = perCloneBudgetOverride ??
      (config.perCloneUsd === 'auto' ? config.perCastUsd / cloneCount : config.perCloneUsd);
    return {
      mode,
      cloneCount,
      perCloneCostUsd: perClone,
      totalEstimatedUsd: perClone * cloneCount,
      perCloneBudgetUsd: perCloneBudget,
    };
  }
  ```

  **Test cases:**
  - recon-swarm × 3 → $1.50 × 3 = $4.50
  - forking-realities × 2 → $3.00 × 2 = $6.00
  - Unknown mode falls back to $2.00/clone
  - perCloneUsd: 'auto' computes as perCastUsd / N
  - Explicit perCloneUsd override

  **Acceptance criteria:** All tests pass.

  Commit:
  ```
  feat(cli): implement CostEstimator for pre-spawn cost preview

  Phase 3 Chunk 2 — pure function estimating USD cost per mode and
  clone count, using BudgetConfig cost_estimates.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

---

- [ ] **2.1: AutoDowngradeAdvisor — tests + implementation**

  **Purpose:** Given a budget shortfall (daily cap would be exceeded), compute viable downgrade options: reduce N, or suggest a cheaper mode.

  **Files:**
  - Create: `packages/manta-cli/src/budget/auto-downgrade.ts`
  - Create: `packages/manta-cli/tests/budget/auto-downgrade.test.ts`

  **API:**

  ```ts
  import type { Mode } from '@manta/bus';
  import type { ResolvedBudgetConfig } from '../config/budget-config';
  import type { CostEstimate } from './cost-estimator';
  import { estimateCost } from './cost-estimator';

  export interface DowngradeOption {
    label: string;
    mode: Mode;
    cloneCount: number;
    estimatedCostUsd: number;
    viable: boolean;
  }

  export interface DowngradeAdvice {
    originalEstimate: CostEstimate;
    remainingBudgetUsd: number;
    options: DowngradeOption[];
  }

  /**
   * Compute downgrade options when daily budget is insufficient.
   *
   * Strategy:
   * 1. Reduce N: try N-1, N-2, ..., minClones. For each, check if remaining >= estimate.
   * 2. Cheaper mode: if current mode has a cheaper alternative with same wave, suggest it.
   *    recon-swarm is the cheapest; forking-realities can downgrade to recon-swarm for read-only tasks.
   */
  export function computeDowngradeOptions(
    mode: Mode,
    cloneCount: number,
    remainingBudgetUsd: number,
    config: ResolvedBudgetConfig,
  ): DowngradeAdvice { ... }
  ```

  **Test cases:**
  - 3 clones forking-realities, $6 remaining → suggests 2 clones ($6.00 ✓)
  - 3 clones forking-realities, $4 remaining → suggests 1 clone ($3.00 ✓) + recon-swarm 3 clones ($4.50 ✓)
  - 1 clone, $0 remaining → no viable options
  - minClones=2 → won't suggest below 2
  - auto_downgrade.enabled=false → returns empty options

  **Acceptance criteria:** All tests pass.

  Commit:
  ```
  feat(cli): implement AutoDowngradeAdvisor for budget shortfall

  Phase 3 Chunk 2 — computes downgrade options (reduce N, cheaper mode)
  when daily budget would be exceeded. Respects minClones config.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

---

- [ ] **2.2: PreSpawnGate — tests + implementation**

  **Purpose:** Seven-step pre-spawn check sequence that composes charge check, cost estimation, budget validation, daily cap check, auto-downgrade advisory, dry-run output, and deduction commitment. This is the core integration point for Phase 3.

  **Files:**
  - Create: `packages/manta-cli/src/budget/pre-spawn-gate.ts`
  - Create: `packages/manta-cli/tests/budget/pre-spawn-gate.test.ts`

  **API:**

  ```ts
  import type { ChargeStore, DailySpendLedger, Mode } from '@manta/bus';
  import type { ResolvedBudgetConfig } from '../config/budget-config';
  import type { Reporter } from '../output/reporter';
  import type { CostEstimate } from './cost-estimator';
  import type { DowngradeAdvice } from './auto-downgrade';

  export interface PreSpawnGateOptions {
    mode: Mode;
    cloneCount: number;
    castId: string;
    budgetUsdPerClone: number;
    budgetUsdPerCast: number;
    dailyCapUsdOverride?: number;
    force: boolean;
    noChargeCheck: boolean;
    dryRun: boolean;
    config: ResolvedBudgetConfig;
    charges: ChargeStore;
    dailySpend: DailySpendLedger;
    reporter: Reporter;
  }

  export interface PreSpawnGateResult {
    passed: boolean;
    costEstimate: CostEstimate;
    chargesAfterDeduct: number;
    dailySpentAfter: number;
    dailyRemaining: number;
    downgradeAdvice?: DowngradeAdvice;
    /** If passed=true and dryRun=false, charges and daily-spend have been committed. */
    committed: boolean;
  }

  /**
   * Seven-step pre-spawn gate (spec Sec 9.4 + Sec 6.4).
   *
   * 1. PASSIVE RECOVERY — apply pending idle recovery credits
   * 2. CHARGE CHECK — charges >= mode cost? Overdraft restriction? Cooldown?
   * 3. COST ESTIMATION — estimated_cost = cloneCount × cost_estimates[mode]
   * 4. PER-CAST BUDGET CHECK (L1) — Σ(per-clone effective) ≤ per-cast
   *    (existing gate in cast.ts, but PreSpawnGate validates too for dry-run)
   * 5. DAILY CAP CHECK (L3) — daily_spent + estimated ≤ daily_cap
   * 6. AUTO-DOWNGRADE (L4) — if daily cap exceeded, compute options
   * 7. DRY-RUN OUTPUT (L5) — if --dry-run, print preview and stop
   *
   * If all checks pass and not dry-run: deduct charges, record daily spend.
   * If --force: skip daily cap check.
   * If --no-charge-check: skip charge system entirely.
   */
  export async function runPreSpawnGate(
    opts: PreSpawnGateOptions,
  ): Promise<PreSpawnGateResult> { ... }
  ```

  **Dry-run output format (printed to reporter when dryRun=true):**

  ```
  Dry Run: recon-swarm
    Clones:     3 (A, B, C)
    Mode:       recon-swarm (charge cost: 1)
    Est. cost:  ~$4.50 (3 × $1.50/clone)
    Per-clone:  $5.00 budget
    Budget check:
      Per-cast:   $15.00 ≥ $15.00 ............  ✓
      Daily cap:  $50.00 - $23.50 = $26.50 ≥ $4.50  ✓
      Charges:    3 ≥ 1 (recon-swarm cost) ...  ✓
    After cast:
      Daily spent: ~$28.00 / $50.00
      Charges:     2 / 5
  ```

  **Test cases (use fake ChargeStore and DailySpendLedger in tmp dirs):**
  - All checks pass → committed=true, charges deducted, daily-spend recorded
  - dryRun=true → passed=true, committed=false, reporter called with preview
  - Insufficient charges → passed=false, throws CliError(budget_gate_failed)
  - Cooldown active → passed=false, throws CliError(budget_gate_failed)
  - Daily cap exceeded → computes downgrade advice
  - Daily cap exceeded + force=true → passes anyway
  - noChargeCheck=true → skips charge deduction
  - Passive recovery applies credits before charge check
  - Overdraft + cost > 1 → rejected even if charges technically available

  **Acceptance criteria:** All tests pass. The gate correctly composes all seven steps. Coverage ≥ 80%.

  Commit:
  ```
  feat(cli): implement PreSpawnGate seven-step pre-spawn check

  Phase 3 Chunk 2 — composes charge check, cost estimation, budget
  validation, daily cap, auto-downgrade, dry-run output, and deduction
  commit into a single pre-spawn gate. Spec Sec 9.4 + 6.4.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

---

- [ ] **2.3: Wire PreSpawnGate into cast.ts + new RunCastOptions fields**

  **Purpose:** Insert the PreSpawnGate call into `runCastCommand` before the spawn loop. Add new fields to `RunCastOptions` for the Phase 3 flags.

  **Files:**
  - Modify: `packages/manta-cli/src/commands/cast.ts`

  **RunCastOptions additions** (append to existing interface at `cast.ts:42-69`):

  ```ts
  /** Daily cap override (CLI: --daily-cap-usd). If undefined, reads from BudgetConfig. */
  dailyCapUsdOverride?: number;
  /** Skip charge system check (CLI: --no-charge-check). Default false. */
  noChargeCheck?: boolean;
  /** Force past daily cap (CLI: --force). Default false. */
  force?: boolean;
  /** Dry-run mode: print cost preview, do not spawn (CLI: --dry-run). Default false. */
  dryRun?: boolean;
  ```

  **Integration point in runCastCommand** — after the existing cumulative-budget gate (`cast.ts:183-192`) and before MCP pre-flight (`cast.ts:196-198`):

  ```ts
  // --- Phase 3: Pre-spawn gate (charge + daily budget + dry-run) ---
  const budgetConfig = await loadBudgetConfig(rt.repoRoot);
  const gateResult = await runPreSpawnGate({
    mode: opts.mode,
    cloneCount: opts.cloneCount,
    castId: opts.castId,
    budgetUsdPerClone: opts.budgetUsdPerClone,
    budgetUsdPerCast: opts.budgetUsdPerCast,
    dailyCapUsdOverride: opts.dailyCapUsdOverride,
    force: opts.force ?? false,
    noChargeCheck: opts.noChargeCheck ?? false,
    dryRun: opts.dryRun ?? false,
    config: budgetConfig,
    charges: rt.ctx.charges,
    dailySpend: rt.ctx.dailySpend,
    reporter: opts.reporter,
  });

  if (opts.dryRun) {
    return {
      exitCode: 0,
      stdout: `Dry run complete for cast ${opts.castId}. No clones spawned.`,
    };
  }
  ```

  **Note on existing cumulative gate:** The existing gate at `cast.ts:183-192` (`totalBudgetUsd > opts.budgetUsdPerCast`) stays as-is — it validates per-cast budget allocation (L1/L2). The PreSpawnGate adds L3 (daily cap) and charge check on top. The existing gate runs first (it's a simple arithmetic check); if it passes, PreSpawnGate handles the rest.

  **Test strategy:** Modify existing `packages/manta-cli/tests/commands/cast.test.ts` to ensure:
  - Existing tests still pass with the new optional fields defaulting to undefined/false
  - New test: dryRun=true returns without spawning
  - New test: noChargeCheck=true bypasses charge check

  **Acceptance criteria:** All existing cast tests pass. New gate is invoked. dryRun short-circuits correctly.

  Commit:
  ```
  feat(cli): wire PreSpawnGate into cast.ts pre-spawn path

  Phase 3 Chunk 2 — insert charge/budget/daily-cap gate before clone
  spawning in runCastCommand. Adds dryRun, force, noChargeCheck,
  dailyCapUsdOverride to RunCastOptions. Existing cumulative budget
  gate (L1/L2) preserved; new gate adds L3 + charge system.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

---

- [ ] **2.4: Post-cast settlement in cast.ts**

  **Purpose:** After the tick loop exits and clones are reaped, classify the cast outcome and adjust charges. Update daily-spend if actual data becomes available (Phase 3: no-op; placeholder for future).

  **Files:**
  - Modify: `packages/manta-cli/src/commands/cast.ts` — add settlement block after timeline seal (`cast.ts:354`) and before merge-review (`cast.ts:356`).
  - Create: `packages/manta-cli/tests/budget/settlement.test.ts`

  **Settlement sequence (inserted at `cast.ts:354`, after `await timeline.seal(...)`):**

  ```ts
  // --- Phase 3: Post-cast settlement ---
  if (!opts.noChargeCheck) {
    const allClones = await rt.ctx.registry.list();
    const castClones = allClones.filter((c) => cloneIds.includes(c.clone_id));
    const outcome = classifyCastOutcome({
      clones: castClones,
      budgetAborted: loopResult.aborted,
    });

    switch (outcome) {
      case 'success':
        await rt.ctx.charges.creditSuccess(opts.castId, opts.mode);
        break;
      case 'fail':
        await rt.ctx.charges.creditFail(opts.castId, opts.mode);
        break;
      case 'neutral':
        await rt.ctx.charges.creditNeutral(opts.castId, opts.mode);
        break;
    }

    // Update last_cast_ended_at for passive recovery timer
    // (handled inside creditSuccess/creditFail/creditNeutral)

    opts.reporter.info('cast.settlement', {
      cast: opts.castId,
      outcome,
      charges: (await rt.ctx.charges.read()).current_charges,
    });
  }
  ```

  **Placement rationale:** Settlement runs BEFORE merge-review for both modes. The charge outcome is based on clone health (did they complete? did they crash?) — not on merge-review quality. Merge-review is a separate concern that doesn't affect charge accounting.

  **Test cases (settlement.test.ts — uses fakeCloneRunner pattern from existing tests):**
  - All clones complete normally → SUCCESS → charges +1
  - Budget abort → FAIL → charges -1
  - Budget abort + in overdraft → FAIL → cooldown triggered
  - Manual kill → NEUTRAL → charges unchanged
  - noChargeCheck=true → no settlement
  - Settlement reporter event emitted with correct outcome

  **Acceptance criteria:** All tests pass. Charges adjust correctly on cast completion.

  Commit:
  ```
  feat(cli): add post-cast charge settlement in cast.ts

  Phase 3 Chunk 2 — after tick loop + reap, classifies cast outcome
  and adjusts charges via ChargeStore. Settlement runs before merge-
  review and emits cast.settlement reporter event.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

---

- [ ] **2.5: New CLI flags on manta cast**

  **Purpose:** Add `--dry-run`, `--daily-cap-usd`, `--force`, and `--no-charge-check` flags to the `manta cast` CLI command.

  **File:** `packages/manta-cli/src/bin/manta.ts`

  **Changes to the `cast` command definition (currently at `manta.ts:53-141`):**

  ```ts
  .option('--dry-run', 'Show cost preview without spawning', false)
  .option('--daily-cap-usd <amount>', 'Override daily budget cap (default: from config or $50)', parseFloat)
  .option('--force', 'Force cast even if daily cap would be exceeded', false)
  .option('--no-charge-check', 'Skip charge system check (testing only)', false)
  ```

  **Wire into RunCastOptions (in the action handler, around `manta.ts:119-141`):**

  ```ts
  dryRun: options.dryRun ?? false,
  dailyCapUsdOverride: options.dailyCapUsd,
  force: options.force ?? false,
  noChargeCheck: options.noChargeCheck ?? false,
  ```

  **Test strategy:** The existing CLI parsing tests in `packages/manta-cli/tests/bin/` (if any) verify flag parsing. Integration tests in Task 2.3 verify the flags reach runCastCommand correctly.

  **Acceptance criteria:** `manta cast recon-swarm --dry-run` prints preview and exits 0. `--force` flag passes through to PreSpawnGate.

  Commit:
  ```
  feat(cli): add --dry-run, --daily-cap-usd, --force, --no-charge-check flags

  Phase 3 Chunk 2 — four new flags on manta cast for charge/budget
  control. --dry-run shows cost preview without spawning.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

---

- [ ] **2.6: `manta cost` command**

  **Purpose:** Show daily/weekly spend summary. Spec Sec 11 line 479.

  **Files:**
  - Create: `packages/manta-cli/src/commands/cost.ts`
  - Create: `packages/manta-cli/tests/commands/cost.test.ts`
  - Modify: `packages/manta-cli/src/bin/manta.ts` — register command

  **API:**

  ```ts
  import type { Runtime, CommandResult } from './cast';

  export interface CostCommandOptions {
    period?: 'today' | 'week';
  }

  export async function runCostCommand(
    rt: Runtime,
    opts: CostCommandOptions,
  ): Promise<CommandResult> { ... }
  ```

  **Output format (today — default):**

  ```
  Daily budget: $23.50 / $50.00 (47%)
  ████████████░░░░░░░░ 47%

  Today's casts:
    cast-1779825540200  recon-swarm    3 clones  ~$4.50   3:59pm
    cast-1779824100000  forking-real.  2 clones  ~$6.00   2:30pm

  Remaining today: $26.50
  Charges: 3/5
  ```

  **Output format (week):**

  ```
  This week: $187.50
    Mon $42.00  Tue $38.50  Wed $50.00  Thu $29.00  Fri $28.00
    Avg: $37.50/day
  ```

  **Implementation:** Reads `DailySpendLedger` for today. For weekly, reads charges.log and aggregates by date (JSONL scan — efficient for <1000 entries). Reads `ChargeStore` for current charges display.

  **CLI registration (manta.ts):**

  ```ts
  program
    .command('cost [period]')
    .description('Show daily/weekly spend summary')
    .action(async (period: string | undefined) => {
      const p = period === 'week' ? 'week' : 'today';
      const result = await runCostCommand(rt, { period: p });
      process.stdout.write(result.stdout + '\n');
    });
  ```

  **Test cases:**
  - Today with entries → formatted output
  - Today with no entries → "No casts today"
  - Week aggregation from charges.log
  - Charges display included

  **Acceptance criteria:** `manta cost` and `manta cost week` produce correct output.

  Commit:
  ```
  feat(cli): implement manta cost command for spend summary

  Phase 3 Chunk 2 — daily and weekly spend summary with progress bar,
  cast list, and remaining budget. Reads DailySpendLedger + charges.log.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

---

- [ ] **2.7: `manta charges` command**

  **Purpose:** Show charge system state — current charges, cooldown status, mode availability.

  **Files:**
  - Create: `packages/manta-cli/src/commands/charges.ts`
  - Create: `packages/manta-cli/tests/commands/charges.test.ts`
  - Modify: `packages/manta-cli/src/bin/manta.ts` — register command

  **Output format (nominal):**

  ```
  Charges: 3 / 5
  State: nominal
  Last cast: 12 min ago (success, +1)
  Idle recovery: next +1 in 18 min

  Mode availability:
    recon-swarm (1)         ✓
    forking-realities (2)   ✓
    bug-hunt (2)            ✓
    council (3)             ✓
    phantom-lance (3)       ✓
  ```

  **Output format (overdraft):**

  ```
  Charges: -1 / 5
  State: OVERDRAFT
    Next failure triggers 24h cooldown.
    Only cost-1 modes available.
    Idle recovery: next +1 in 8 min

  Mode availability:
    recon-swarm (1)         ✓
    forking-realities (2)   ✗ (need 2, have -1)
    bug-hunt (2)            ✗ (need 2, have -1)
    council (3)             ✗ (need 3, have -1)
  ```

  **Implementation:** Reads `ChargeStore.read()`, computes time since last activity, formats mode availability by comparing `current_charges` against `MODE_CHARGE_COST[mode]`.

  **Test cases:**
  - Nominal state → correct display
  - Overdraft → warning + restricted modes
  - Cooldown active → shows time remaining
  - All modes listed with ✓/✗

  **Acceptance criteria:** `manta charges` produces correct output for all states.

  Commit:
  ```
  feat(cli): implement manta charges command for charge state display

  Phase 3 Chunk 2 — shows current charges, state, idle recovery timer,
  and per-mode availability based on MODE_CHARGE_COST.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

---

- [ ] **2.8: `manta refresh` command**

  **Purpose:** Reset cooldown with double-confirm. Spec Sec 6.7.

  **Files:**
  - Create: `packages/manta-cli/src/commands/refresh.ts`
  - Create: `packages/manta-cli/tests/commands/refresh.test.ts`
  - Modify: `packages/manta-cli/src/bin/manta.ts` — register command

  **UX flow:**

  ```
  $ manta refresh
  ⚠️  This resets the 24h cooldown.
      Your last cast failed in overdraft.
      Charges will be set to 0.

  Type "refresh" to confirm: refresh
  Type "refresh" again to double-confirm: refresh
  Cooldown cleared. Charges set to 0.
  ```

  **Implementation:**
  1. Read `ChargeStore` — if no cooldown active, print "No cooldown active." and exit.
  2. Print warning with cooldown details.
  3. Prompt for "refresh" twice via stdin readline.
  4. Call `ChargeStore.clearCooldown()`.
  5. Print confirmation.

  **Non-interactive mode (stdin not TTY):** Exit with error "manta refresh requires interactive confirmation".

  **Test cases:**
  - No cooldown → "No cooldown active" message
  - Cooldown active + correct confirms → cleared
  - Cooldown active + wrong confirm → rejected
  - Non-TTY → error

  **Acceptance criteria:** Double-confirm flow works. Cooldown is cleared. Charges set to 0.

  Commit:
  ```
  feat(cli): implement manta refresh command with double-confirm

  Phase 3 Chunk 2 — resets 24h cooldown via ChargeStore.clearCooldown()
  after two confirmation prompts. Requires interactive terminal.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

---

- [ ] **2.9: `manta limit` command**

  **Purpose:** Read/write budget configuration. `manta limit get` shows current config, `manta limit set <key> <value>` updates it.

  **Files:**
  - Create: `packages/manta-cli/src/commands/limit.ts`
  - Create: `packages/manta-cli/tests/commands/limit.test.ts`
  - Modify: `packages/manta-cli/src/bin/manta.ts` — register command

  **CLI registration:**

  ```ts
  const limitCmd = program
    .command('limit')
    .description('Read/write budget configuration');

  limitCmd
    .command('get [key]')
    .description('Show budget config (all or specific key)')
    .action(async (key?: string) => { ... });

  limitCmd
    .command('set <key> <value>')
    .description('Update a budget config value')
    .action(async (key: string, value: string) => { ... });
  ```

  **Output format:**

  ```
  $ manta limit get
  per_cast_usd:        15
  per_clone_usd:       auto (computed: per_cast / N)
  daily_cap_usd:       50
  auto_downgrade:      enabled, confirm=true, min_clones=1
  charges.initial:     3
  charges.max:         5
  charges.min:         -1
  charges.idle_recovery_minutes: 30
  charges.cooldown_hours: 24

  $ manta limit set daily_cap_usd 100
  Updated daily_cap_usd: 50 → 100

  $ manta limit set auto_downgrade.confirm false
  Updated auto_downgrade.confirm: true → false
  ```

  **Implementation:** Reads `loadBudgetConfig()` for get. For set: reads, modifies, writes back to `.manta/config/budget.json` (creating the file and directory if needed).

  **Test cases:**
  - `get` with no config file → shows defaults
  - `get daily_cap_usd` → shows specific value
  - `set daily_cap_usd 100` → writes file, shows old → new
  - `set` with invalid value → error
  - `set` creates .manta/config/ directory if needed
  - Dotted keys (auto_downgrade.confirm) work

  **Acceptance criteria:** All tests pass. Config file persists correctly.

  Commit:
  ```
  feat(cli): implement manta limit command for budget config management

  Phase 3 Chunk 2 — read/write budget config via CLI. Supports dotted
  key paths for nested values. Creates .manta/config/ if needed.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

---

- [ ] **2.10: Integration tests**

  **Purpose:** End-to-end integration tests for the full charge/budget lifecycle within the CLI test harness (using `fakeCloneRunner`).

  **Files:**
  - Create: `packages/manta-cli/tests/integration/charge-budget.test.ts`

  **Test scenarios:**

  1. **Full happy path:** Create ChargeStore + DailySpendLedger in tmp dir. Run PreSpawnGate (recon-swarm × 3). Verify charges deducted by 1, daily spend recorded. Simulate cast completion (mark clones DEAD with no crash reasons). Run settlement. Verify charges credited +1 (net change: 0). Verify daily spend entry.

  2. **Charge exhaustion:** Set charges to 1. Attempt forking-realities (cost 2). Verify CliError(budget_gate_failed).

  3. **Daily cap enforcement:** Set daily_cap_usd=5, spent_usd=4. Attempt recon-swarm × 3 (est ~$4.50). Verify gate fails. Verify downgrade options provided.

  4. **Passive recovery:** Set last_cast_ended_at to 35 min ago, charges=2. Run PreSpawnGate. Verify charges=3 (one recovery slot applied) before deduction.

  5. **Cooldown flow:** Set charges=-1, trigger cooldown. Verify PreSpawnGate rejects. Clear cooldown. Verify gate passes with charges=0 (cost-1 mode only).

  6. **Settlement failure path:** Budget abort → FAIL → charges -1.

  7. **Settlement neutral:** All clones manually killed → NEUTRAL → charges unchanged.

  **Acceptance criteria:** All 7 scenarios pass. Full lifecycle verified.

  Commit:
  ```
  test(cli): add charge/budget integration tests for full lifecycle

  Phase 3 Chunk 2 — 7 test scenarios covering happy path, charge
  exhaustion, daily cap, passive recovery, cooldown, and settlement.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

---

- [ ] **2.11: e2e smoke test**

  **Purpose:** End-to-end test using the real CLI binary with `fakeCloneRunner`, verifying the full charge+budget flow from CLI invocation through settlement.

  **Files:**
  - Create: `packages/manta-e2e/tests/charge-system.e2e.test.ts`

  **Test pattern:** Follow the existing e2e pattern from `packages/manta-e2e/tests/recon-swarm.e2e.test.ts`:
  1. Create tmp repo with git init.
  2. Initialize `.manta/state/` with a known charge state (charges=3).
  3. Run `manta cast recon-swarm --dry-run -n 2 -t "test task" --budget-per-clone-usd 5` via the CLI binary.
  4. Verify dry-run output includes charge check (✓), daily cap check (✓), cost estimate.
  5. Verify no clones spawned (no worktrees created).
  6. Verify charges.json unchanged (dry-run doesn't deduct).
  7. Run `manta charges` — verify output shows "3 / 5".
  8. Run `manta cost` — verify output shows $0 spent.
  9. Run `manta limit get` — verify defaults displayed.

  **Acceptance criteria:** e2e test passes in CI. Dry-run produces correct output. CLI commands work end-to-end.

  Commit:
  ```
  test(e2e): add charge-system e2e smoke test

  Phase 3 Chunk 2 — verifies dry-run, charges, cost, and limit commands
  work end-to-end via the real CLI binary.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

---

- [ ] **2.12: Full sweep + docs + final commit**

  **Purpose:** Run the full cross-package test sweep, verify coverage, update docs.

  **Steps:**

  1. Run: `pnpm -r build && pnpm -r test`
     Expected: all green.

  2. Verify coverage ≥ 80% on all new files:
     - `packages/manta-bus/src/state/charge-store.ts`
     - `packages/manta-bus/src/state/daily-spend.ts`
     - `packages/manta-cli/src/config/budget-config.ts`
     - `packages/manta-cli/src/budget/cost-estimator.ts`
     - `packages/manta-cli/src/budget/pre-spawn-gate.ts`
     - `packages/manta-cli/src/budget/auto-downgrade.ts`
     - `packages/manta-cli/src/budget/cast-outcome.ts`
     - `packages/manta-cli/src/commands/cost.ts`
     - `packages/manta-cli/src/commands/charges.ts`
     - `packages/manta-cli/src/commands/refresh.ts`
     - `packages/manta-cli/src/commands/limit.ts`

  3. Update `packages/manta-bus/ARCHITECTURE.md` — add section on ChargeStore and DailySpendLedger under "State files".

  4. Update `packages/manta-bus/README.md` — add charges.json, charges.log, daily-spend.json to "On-disk layout".

  5. Create `docs/user/charge-system.md` — operator-facing guide covering charges, budget, dry-run, refresh, limit commands.

  Commit:
  ```
  docs: Phase 3 charge system operator guide + architecture update

  Phase 3 Chunk 2 complete — full charge system + multi-layer budget
  shipped. All tests green, coverage ≥ 80%.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

---

## Cross-chunk field-name reference table

To prevent the #1 Phase 0 blocker class (cross-plan field-name drift), this table maps every interface/type used across chunk boundaries.

| Consumer (Chunk 2) | Provider (Chunk 1) | Exact import path | Key fields |
|---|---|---|---|
| `PreSpawnGate` | `ChargeStore` | `@manta/bus` → `state/charge-store.ts` | `.read()`, `.deductForCast(castId, mode)`, `.applyPassiveRecovery()` |
| `PreSpawnGate` | `DailySpendLedger` | `@manta/bus` → `state/daily-spend.ts` | `.read()`, `.recordCastStart(entry)`, `.getRemaining(dailyCapUsd)` |
| `PreSpawnGate` | `ResolvedBudgetConfig` | `@manta/cli` → `config/budget-config.ts` | `.perCastUsd`, `.dailyCapUsd`, `.costEstimates`, `.autoDowngrade` |
| `CostEstimator` | `ResolvedBudgetConfig` | `@manta/cli` → `config/budget-config.ts` | `.costEstimates[mode]`, `.perCloneUsd`, `.perCastUsd` |
| `AutoDowngradeAdvisor` | `ResolvedBudgetConfig` | `@manta/cli` → `config/budget-config.ts` | `.autoDowngrade.enabled`, `.autoDowngrade.minClones`, `.costEstimates` |
| Settlement (cast.ts) | `ChargeStore` | `@manta/bus` → `state/charge-store.ts` | `.creditSuccess()`, `.creditFail()`, `.creditNeutral()` |
| Settlement (cast.ts) | `classifyCastOutcome` | `@manta/cli` → `budget/cast-outcome.ts` | `CastOutcomeInput.clones`, `.budgetAborted` |
| `manta charges` | `ChargeStore` | `@manta/bus` → `state/charge-store.ts` | `.read()` → `ChargeState.current_charges`, `.cooldown_until` |
| `manta charges` | `MODE_CHARGE_COST` | `@manta/bus` → `schema.ts` | `MODE_CHARGE_COST[mode]` — number |
| `manta cost` | `DailySpendLedger` | `@manta/bus` → `state/daily-spend.ts` | `.read()` → `DailySpendState.entries`, `.spent_usd` |
| `manta cost` | `ChargeStore` | `@manta/bus` → `state/charge-store.ts` | `.readLog()` → `ChargeEvent[]` (for weekly aggregation) |
| `manta refresh` | `ChargeStore` | `@manta/bus` → `state/charge-store.ts` | `.read()`, `.clearCooldown()` |
| `manta limit` | `loadBudgetConfig` | `@manta/cli` → `config/budget-config.ts` | `ResolvedBudgetConfig` (all fields) |
| `BusPaths` | `ChargeStateSchema` | `@manta/bus` → `schema.ts` | Used for path validation — `charges`, `chargesLog`, `dailySpend` fields |
| `BusContext` | `ChargeStore`, `DailySpendLedger` | `@manta/bus` → `tools/index.ts` | `.charges`, `.dailySpend` fields on context |

## Risk assessment

| Risk | Severity | Mitigation |
|---|---|---|
| Cost estimates wildly inaccurate | Medium | Conservative defaults + `--force` escape hatch + telemetry via `cost_type: 'estimate'` field |
| Daily cap too restrictive | Low | Configurable via `manta limit set daily_cap_usd` + `--force` + sensible $50 default |
| Charge system too punitive | Medium | Passive recovery (30 min) + `/manta refresh` + config tuning |
| CastOutcomeClassifier misclassifies | Medium | Freeform `death_reason` strings may evolve — classifier uses substring matching with known patterns; unknown patterns → NEUTRAL (safe default) |
| Auto-downgrade confuses user | Medium | `confirm: true` default; clear messaging; `--force` override |
| Race on daily-spend.json | Low | Atomic write (tmp+rename); single-writer in practice; last-write-wins acceptable |
| Clock skew on daily boundary | Low | Uses local date; UTC timestamps in audit trail for forensics |
| charges.json corruption after crash | Low | Reconstructible from charges.log (replay all deltas from initial state) |
