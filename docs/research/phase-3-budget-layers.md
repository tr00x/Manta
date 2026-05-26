# Phase 3 — Multi-Layer Token Budget System Design

> Research deliverable for Phase 3 planning. Maps spec Sec 9.4 budget layers
> onto the existing CLI/cast infrastructure and designs the implementation surface.

## 1. Current State (what exists today)

### 1.1 CLI Flags (Phase 0d)

| Flag | Default | Where parsed | Where enforced |
|---|---|---|---|
| `--budget-per-clone-usd <amt>` | `$5` | `manta.ts:59` → `parseFloat` | `cast.ts:175` — per-clone effective overlay |
| `--budget-per-cast-usd <amt>` | `$15` | `manta.ts:61` → `parseFloat` | `cast.ts:183` — cumulative cost gate: `Σ(effective per-clone) ≤ per-cast` |

### 1.2 Budget Flow in cast.ts

```
CLI flags → RunCastOptions.budgetUsdPerClone / budgetUsdPerCast
  → per-clone effective overlay (cloneAssignments override or cast-level default)
  → cumulative gate: sum(effective.budgetUsd) > budgetUsdPerCast → CliError
  → snapshot.budget.dollarsTotal = effective.budgetUsd per clone
  → snapshot written to disk → clone reads at startup
```

**Critical gap:** the cumulative cost gate is a *pre-spawn admission check*, not enforcement of actual spend. No token-counting exists. The snapshot's `dollarsUsed` starts at 0 and is never updated. Phase 0 docs explicitly note this: *"These are gates, not enforcement of actual spend (no token-counting in Phase 0)."*

### 1.3 Snapshot Budget Schema (`@manta/snapshot`)

```typescript
BudgetSchema = z.object({
  tokensTotal: z.number().int().nonnegative(),  // unused (always 0)
  tokensUsed:  z.number().int().nonnegative(),  // unused (always 0)
  dollarsTotal: z.number().nonnegative(),        // from --budget-per-clone-usd
  dollarsUsed:  z.number().nonnegative(),        // always 0 (no tracking)
});
```

### 1.4 What Does NOT Exist

- **No charge system.** Spec Sec 6.4 describes charges but nothing is implemented. No `charges.json`, no charge ledger, no cooldown enforcement.
- **No daily cap.** No persistent state tracking cumulative daily spend.
- **No actual cost tracking.** Claude Code `--print` mode does not report token usage back to the parent process. The budget fields in the snapshot are declarative, not enforced.
- **No dry-run command.** The spec mentions `/manta dry-run <mode> [args]` but no implementation exists.
- **No auto-downgrade.** No mechanism to detect "daily remainder < cast cost" and suggest reduced clone count or cheaper mode.
- **No config file.** Budget defaults are hardcoded in `manta.ts` options. No `.manta/config/budget.json` or similar.

## 2. Spec Requirements (Sec 9.4 + Sec 6.4)

### 2.1 Five Budget Layers (Sec 9.4)

| Layer | Spec text | Default | Enforcement point |
|---|---|---|---|
| L1: Hard token budget per cast | "default $15, configurable" | $15 | Pre-spawn gate + live tracking |
| L2: Per-clone hard limit | "budget / N (auto-recompute if N changes)" | $15/N | Snapshot + clone-side |
| L3: Daily session cap | "default $50, configurable. При превышении — касты блокируются до завтра." | $50 | Pre-spawn gate |
| L4: Auto-downgrade | "если daily остаток < cost запрошенного режима — N клонов уменьшается автоматически, либо режим даунгрейдится до более дешёвого аналога (предлагается мейну, не делается тихо)" | N/A | Pre-spawn advisory |
| L5: Cost preview / dry-run | "каждый cast сначала проходит `/manta dry-run` который выдаёт estimated cost + ETA + plan; мейн (или auto-mode) аппрувит" | N/A | Separate command / flag |

### 2.2 Charge System (Sec 6.4) — Runs Above Budget Layers

The charge system is **frequency-limiting**, not cost-limiting. It prevents rapid-fire casts after failures. Budget layers are **cost-limiting**. They compose orthogonally:

```
Can I cast?
  1. charges >= mode.chargeCost?           → Charge system (frequency)
  2. estimated_cost <= per_cast_budget?     → L1 (per-cast)
  3. per_clone_cost <= per_cast / N?        → L2 (per-clone)
  4. daily_spent + estimated_cost <= daily? → L3 (daily cap)
  5. If L3 fails, can we downgrade?         → L4 (auto-downgrade advisory)
  6. Show the plan to main                  → L5 (dry-run / cost preview)
```

## 3. Design: Persistent State

### 3.1 Daily Spend Ledger

**Location:** `.manta/state/daily-spend.json`

```typescript
interface DailySpendLedger {
  /** ISO date string, e.g. "2026-05-26". Resets when date changes. */
  date: string;
  /** Cumulative estimated spend for this day, in USD. */
  spent_usd: number;
  /** Array of cast entries contributing to today's spend. */
  entries: DailySpendEntry[];
}

interface DailySpendEntry {
  cast_id: string;
  mode: Mode;
  clone_count: number;
  estimated_cost_usd: number;
  /** Was this estimate or actual (Phase 3+: actual from token counting). */
  cost_type: 'estimate' | 'actual';
  started_at: number;  // epoch ms
}
```

**Why not same store as charges?** Charges track *outcome quality* (success/fail/neutral) and decay passively. Daily spend tracks *monetary cost* and resets on calendar boundary. Different lifecycle, different schema, different reset logic. Coupling them creates a fragile dependency — a charge refund should not affect spend accounting, and vice versa.

**Atomic updates:** same JSON + tmp-rename pattern as `Registry` and `CastsStore`. No SQLite yet — the spec suggests *evaluating* sqlite vs JSON+lockfile via forking-realities for charge persistence (Sec 15.1 Phase 3 build-by), but the daily-spend ledger is simple enough that JSON suffices regardless. The forking-realities evaluation applies to the *charge ledger* (which has passive recovery timers, bankruptcy cascades, cooldown state machines — genuinely complex).

### 3.2 Charge Ledger

**Location:** `.manta/state/charges.json`

```typescript
interface ChargeLedger {
  current_charges: number;        // [-1, charges_max]
  last_change_at: number;         // epoch ms
  last_idle_recovery_at: number;  // epoch ms — for passive +1/30min
  cooldown_until: number | null;  // epoch ms — 24h hard cooldown, or null
  history: ChargeEvent[];         // append-only audit trail
}

interface ChargeEvent {
  ts: number;
  delta: number;           // +1, -1, -2, etc.
  reason: 'cast_success' | 'cast_fail' | 'cast_neutral' | 'idle_recovery' | 'manual_refresh';
  cast_id: string | null;  // null for idle_recovery / manual_refresh
  mode: Mode | null;
}
```

**Audit log:** `.manta/state/charges.log` — one JSONL line per ChargeEvent. Immutable append-only, never truncated.

### 3.3 Budget Config

**Location:** `.manta/config/budget.json`

```typescript
interface BudgetConfig {
  /** Hard per-cast budget in USD. CLI --budget-per-cast-usd overrides. */
  per_cast_usd: number;            // default 15
  /** Per-clone budget. Auto-computed as per_cast_usd / N unless overridden. */
  per_clone_usd: number | 'auto';  // default 'auto'
  /** Daily session cap in USD. */
  daily_cap_usd: number;           // default 50
  /** Mode-specific cost estimates (USD per clone per 20 min session). */
  cost_estimates: Record<Mode, number>;
  /** Auto-downgrade behavior. */
  auto_downgrade: {
    enabled: boolean;               // default true
    /** Require interactive confirmation before downgrading. */
    confirm: boolean;               // default true (spec: "предлагается мейну, не делается тихо")
    /** Minimum clone count after downgrade (won't go below this). */
    min_clones: number;             // default 1
  };
}
```

**Default cost estimates** (based on typical Opus usage at $15/1M input, $75/1M output for a 20-min clone session):

| Mode | Est. cost/clone | Rationale |
|---|---|---|
| recon-swarm | $1.50 | read-only, moderate context |
| forking-realities | $3.00 | write-heavy, full context |
| pair-programming | $2.00 | iterative but smaller scope |
| test-storm | $3.00 | high output (tests + chaos) |
| bug-hunt | $2.50 | deep read + targeted writes |
| refactor-wave | $3.00 | many files, similar patterns |
| documentation-chase | $1.00 | low complexity writes |
| phantom-lance | $4.00 | recursive, compounding |
| council | $2.00 | read + propose, no merge |
| decoy | $1.50 | draft quality, not final |

These are *estimates* for dry-run costing; they do not constrain actual spend (L1/L2 budget does that). They'll be tuned via Phase 3 dogfood telemetry.

## 4. Design: Layer Interaction Model

### 4.1 Pre-Spawn Gate Sequence

Every `manta cast` passes through this gate before spawning any clones:

```
┌─────────────────────────────────────────────────┐
│ 1. CHARGE CHECK                                  │
│    charges.current >= mode.chargeCost?           │
│    NO → error: "Insufficient charges (have N,    │
│          need M). Wait for idle recovery or       │
│          /manta refresh."                         │
│    In overdraft? Only allow cost ≤ 1 modes.      │
│    In cooldown? Block entirely (or /manta refresh)│
├─────────────────────────────────────────────────┤
│ 2. COST ESTIMATION                               │
│    estimated = cloneCount × cost_estimates[mode]  │
│    (or user-specified --budget-per-cast-usd if    │
│     explicitly set)                               │
├─────────────────────────────────────────────────┤
│ 3. PER-CAST BUDGET CHECK (L1)                    │
│    sum(per-clone effective budgets) ≤ per-cast?  │
│    (already exists in cast.ts:183)               │
├─────────────────────────────────────────────────┤
│ 4. DAILY CAP CHECK (L3)                          │
│    daily_spent + estimated ≤ daily_cap?          │
│    NO → try auto-downgrade (L4)                  │
├─────────────────────────────────────────────────┤
│ 5. AUTO-DOWNGRADE ADVISORY (L4)                  │
│    If daily cap would be exceeded:               │
│    a. Try reducing N: N-1, N-2, ... min_clones   │
│    b. Try cheaper mode if applicable              │
│    c. Present options to main (if confirm=true)   │
│    d. If no viable option → block                │
├─────────────────────────────────────────────────┤
│ 6. DRY-RUN OUTPUT (L5)                           │
│    Show: estimated cost, ETA, clone count, mode,  │
│    remaining daily budget, charges after cast,    │
│    per-clone budget breakdown                    │
│    If --dry-run → stop here                      │
│    If interactive → wait for confirm             │
│    If auto-mode → proceed if all checks passed   │
├─────────────────────────────────────────────────┤
│ 7. COMMIT: deduct charges, record daily-spend    │
│    entry, proceed to spawn                       │
└─────────────────────────────────────────────────┘
```

### 4.2 Post-Cast Settlement

After a cast completes:

1. **Charge adjustment:** success → `+1`, fail → `-1`, neutral → `0`.
2. **Daily spend correction (Phase 3+):** If actual token usage data becomes available (e.g., Claude Code exposes cost info), replace the estimate entry with an actual. Until then, estimates are final.
3. **Bankruptcy check:** if `charges < 0` and the cast failed → trigger 24h cooldown.

### 4.3 Passive Recovery (Background)

The orchestrator (or a future daemon) checks periodically:
- If no active clones AND no failures in last 30 min → `charges += 1` (capped at `charges_max`).
- Update `last_idle_recovery_at`.

In Phase 3 (no daemon), passive recovery is checked at cast-start time: compute how many 30-min idle windows have elapsed since `last_idle_recovery_at`, apply them, then proceed with the gate.

## 5. Design: CLI Surface

### 5.1 Modified `manta cast` Flags

| Flag | New? | Default | Notes |
|---|---|---|---|
| `--budget-per-clone-usd <amt>` | Existing | `auto` (was `5`) | Changed default to `'auto'` → computed from per-cast / N. Explicit value overrides. |
| `--budget-per-cast-usd <amt>` | Existing | `15` | Unchanged semantics. |
| `--daily-cap-usd <amt>` | **New** | from config (50) | Override daily cap for this session. |
| `--dry-run` | **New** | false | Show cost preview + plan, do not spawn. Exit 0. |
| `--force` | **New** | false | Skip auto-downgrade advisory; force cast even if daily cap would be exceeded. Requires explicit opt-in — safety valve, not default. |
| `--no-charge-check` | **New** | false | Skip charge system gate. For debugging / testing only. Emits warning. |

### 5.2 New Commands

#### `manta cost [period]`

Show token usage / spend summary.

```
$ manta cost
Daily budget: $23.50 / $50.00 (47%)
████████████░░░░░░░░ 47%

Today's casts:
  cast-1779825540200  recon-swarm    3 clones  ~$4.50   3:59pm
  cast-1779824100000  forking-real.  2 clones  ~$6.00   2:30pm
  cast-1779822000000  recon-swarm    2 clones  ~$3.00   1:15pm
  ... (4 more)

Remaining today: $26.50
Charges: 3/5

$ manta cost week
This week: $187.50
  Mon $42.00  Tue $38.50  Wed $50.00  Thu $29.00  Fri $28.00
  Avg: $37.50/day
```

#### `manta charges`

Show charge system state.

```
$ manta charges
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

Overdraft example:
```
$ manta charges
Charges: -1 / 5
State: OVERDRAFT ⚠️
  Next failure triggers 24h cooldown.
  Only cost-1 modes available.
  Idle recovery: next +1 in 8 min

Mode availability:
  recon-swarm (1)         ✓
  forking-realities (2)   ✗ (need 2, have -1)
  ...
```

#### `manta limit set <key> <val>` / `manta limit get [key]`

Read/write budget config.

```
$ manta limit get
per_cast_usd:   15
per_clone_usd:  auto (computed: per_cast / N)
daily_cap_usd:  50
auto_downgrade: enabled, confirm=true, min_clones=1

$ manta limit set daily_cap_usd 100
Updated daily_cap_usd: 50 → 100

$ manta limit set auto_downgrade.confirm false
Updated auto_downgrade.confirm: true → false
```

#### `manta refresh`

Reset cooldown (existing in spec Sec 6.7). Requires double confirm.

```
$ manta refresh
⚠️  This resets the 24h cooldown. Your last cast failed in overdraft.
    Type "refresh" to confirm: refresh
    Type "refresh" again to double-confirm: refresh
Cooldown cleared. Charges set to 0.
```

### 5.3 Dry-Run Output Format

```
$ manta cast recon-swarm -n 3 -t "map auth layer" --dry-run

╭─ Dry Run: recon-swarm ────────────────────────────╮
│                                                     │
│  Clones:     3 (A, B, C)                           │
│  Mode:       recon-swarm (charge cost: 1)          │
│  Est. cost:  ~$4.50 (3 × $1.50/clone)             │
│  Per-clone:  $5.00 budget ($15.00 / 3)             │
│  ETA:        ~20 min (default deadline)            │
│                                                     │
│  Budget check:                                     │
│    Per-cast:   $15.00 ≥ $15.00 (3×$5) ........  ✓ │
│    Daily cap:  $50.00 - $23.50 used = $26.50       │
│                $26.50 ≥ $4.50 est. .............  ✓ │
│    Charges:    3 ≥ 1 (recon-swarm cost) .......  ✓ │
│                                                     │
│  After cast:                                       │
│    Daily spent: ~$28.00 / $50.00                   │
│    Charges:     2 (if success) or 4 (after idle)   │
│                                                     │
╰─────────────────────────────────────────────────────╯
```

When daily cap is exceeded (auto-downgrade kicks in):

```
$ manta cast forking-realities -n 3 -t "design auth" --dry-run

╭─ Dry Run: forking-realities ──────────────────────╮
│                                                     │
│  ⚠️  Daily budget insufficient for 3 clones.        │
│                                                     │
│  Requested:  3 clones × $3.00 = ~$9.00             │
│  Available:  $50.00 - $44.00 used = $6.00          │
│                                                     │
│  Auto-downgrade options:                           │
│    [1] 2 clones × $3.00 = ~$6.00  ............  ✓ │
│    [2] Switch to recon-swarm, 3 clones = ~$4.50  ✓ │
│    [3] --force to override daily cap               │
│    [4] Cancel                                      │
│                                                     │
╰─────────────────────────────────────────────────────╯
```

## 6. Design: `--dry-run` as Flag vs Separate Command

**Decision: `--dry-run` flag on `manta cast`, NOT a separate `manta dry-run` command.**

Rationale:
1. **DRY:** the dry-run needs the exact same argument parsing as `cast` (mode, -n, -t, --tasks, --budget-*, --allowed-paths, etc.). A separate command duplicates all of this.
2. **Discoverability:** `manta cast --dry-run` is self-evident. `manta dry-run recon-swarm` requires learning a second command with identical args.
3. **Composability:** scripts and the `manta-cast-decide` skill can add `--dry-run` to the same command template.
4. **Spec alignment:** Sec 12 lists `/manta dry-run <mode> [args]` as a separate command, but this is a UX sugar question, not an architectural one. The spec's intent is "preview before spawn" — a flag achieves this with less code and less surface area.

**Implementation:** `runCastCommand` gains a `dryRun: boolean` option. When true, it runs steps 1-6 of the pre-spawn gate (Section 4.1), prints the dry-run output, and returns without spawning. All validation (mode check, clone count, cumulative budget, daily cap, charge check, auto-downgrade) runs identically — the only difference is no `addWorktree` / `spawnClone` call.

For spec-compatibility, we can also add a CLI alias:
```typescript
program
  .command('dry-run <mode>')
  .description('Alias for `manta cast <mode> --dry-run`')
  // ... same options as cast ...
  .action(async (mode, options) => {
    // delegate to cast action with dryRun: true
  });
```

## 7. Design: Auto-Downgrade UX

### 7.1 How Main Gets Notified

The auto-downgrade is an **interactive advisory** during the pre-spawn gate. It is NOT a background decision.

Flow:
1. Cast command reaches daily-cap check.
2. Daily cap would be exceeded.
3. Compute downgrade options:
   - Reduce N: try N-1, N-2, ..., `min_clones`. For each, check if `daily_remaining >= N' × cost_estimate`.
   - Mode substitution: if the mode has a cheaper equivalent (e.g., `forking-realities` → `recon-swarm` for read-only tasks), offer it.
4. Present options to stdout (numbered list).
5. **If `auto_downgrade.confirm = true`:** wait for user selection via stdin prompt.
6. **If `auto_downgrade.confirm = false`:** pick the first viable option (highest N that fits).
7. **If `--force`:** skip entirely, proceed with original parameters.

### 7.2 Non-Interactive Mode (CI / Automation)

When stdin is not a TTY (piped/CI):
- If `auto_downgrade.confirm = true` and downgrade is needed → **error exit**, not hang.
- If `auto_downgrade.confirm = false` → auto-pick silently.
- If `--force` → proceed regardless.

## 8. Design: Integration with Existing Code

### 8.1 Changes to `cast.ts`

```
runCastCommand(rt, opts)
  ├── [existing] mode validation
  ├── [existing] clone count validation
  ├── [NEW] load charge ledger → check charges >= mode cost
  ├── [existing] compute per-clone effective assignments
  ├── [existing] cumulative cost gate
  ├── [NEW] load daily-spend ledger → check daily cap
  ├── [NEW] if daily cap exceeded → auto-downgrade advisory
  ├── [NEW] if --dry-run → print preview, return
  ├── [NEW] deduct charges, record daily-spend entry
  ├── [existing] MCP pre-flight
  ├── [existing] spawn clones
  ├── [existing] tick loop
  ├── [existing] reap
  └── [NEW] post-cast settlement (charge adjust, daily-spend update)
```

### 8.2 New Modules

| Module | Package | Responsibility |
|---|---|---|
| `DailySpendLedger` | `@manta/bus` | Read/write/reset daily-spend.json. Atomic JSON updates. |
| `ChargeLedger` | `@manta/bus` | Read/write charges.json. Deduct/credit charges. Passive recovery. Cooldown management. Append to charges.log. |
| `BudgetConfig` | `@manta/cli` | Load/save `.manta/config/budget.json`. Merge with CLI flag overrides. |
| `CostEstimator` | `@manta/cli` | Compute estimated cost for a mode+N combination. Uses BudgetConfig cost_estimates. |
| `PreSpawnGate` | `@manta/cli` | Orchestrate the full pre-spawn check sequence (charges → budget → daily cap → downgrade → dry-run). |
| `AutoDowngradeAdvisor` | `@manta/cli` | Given a budget shortfall, compute viable downgrade options. |

### 8.3 Changes to `@manta/snapshot`

The `BudgetSchema` is sufficient as-is. The `dollarsTotal` / `dollarsUsed` fields gain meaning when the charge ledger tracks actual spend, but no schema change is needed.

### 8.4 Changes to `Thresholds`

No changes. Budget config is separate from orchestrator thresholds. Budget is a pre-spawn concern; thresholds govern runtime behavior (heartbeats, locks, etc.).

### 8.5 BusContext Extension

```typescript
interface BusContext {
  // ... existing fields ...
  dailySpend: DailySpendLedger;
  charges: ChargeLedger;
}
```

Both stores follow the same pattern as `Registry`, `LocksStore`, etc.: constructed from `busPaths` + `clock`, using JSON files in `.manta/state/`.

## 9. Design: Config File Format

### 9.1 Location

`.manta/config/budget.json` — lives alongside `.manta/config/scoring.json` (already exists for merge-review weights).

### 9.2 Schema

```json
{
  "$schema": "https://manta.dev/schemas/budget.json",
  "per_cast_usd": 15,
  "per_clone_usd": "auto",
  "daily_cap_usd": 50,
  "cost_estimates": {
    "recon-swarm": 1.50,
    "forking-realities": 3.00,
    "pair-programming": 2.00,
    "test-storm": 3.00,
    "bug-hunt": 2.50,
    "refactor-wave": 3.00,
    "documentation-chase": 1.00,
    "phantom-lance": 4.00,
    "council": 2.00,
    "decoy": 1.50
  },
  "auto_downgrade": {
    "enabled": true,
    "confirm": true,
    "min_clones": 1
  },
  "charges": {
    "initial": 3,
    "max": 5,
    "min": -1,
    "idle_recovery_minutes": 30,
    "cooldown_hours": 24
  }
}
```

### 9.3 Override Precedence

```
CLI flag > config file > hardcoded default
```

- `--budget-per-cast-usd 20` overrides `per_cast_usd: 15` in config.
- `--daily-cap-usd 100` overrides `daily_cap_usd: 50` in config.
- Config file missing → all defaults apply.
- Config file present with partial fields → missing fields use defaults.

## 10. Open Questions for Phase 3 Planning

### Q1: Actual Token Tracking

Claude Code `--print` does not currently expose token usage or cost. Options:
- **A) Estimate-only (Phase 3).** Use cost_estimates, accept inaccuracy. Good enough for daily cap. Track actual if/when Claude Code adds cost reporting.
- **B) Parse Claude Code stderr.** Claude Code may print token info to stderr. Fragile, undocumented. Not recommended.
- **C) API instrumentation.** If Manta ever wraps Claude API directly (Phase 5+ daemon-mode), actual tracking becomes trivial.

**Recommendation:** Phase 3 ships with estimates. The daily cap + per-cast budget provides sufficient protection even without exact numbers. Add a `cost_type: 'estimate' | 'actual'` field to track accuracy; when actual data becomes available, estimates can be retroactively corrected.

### Q2: Charge Persistence — SQLite vs JSON+Lockfile

Spec Sec 15.1 explicitly calls for forking-realities to evaluate both approaches. The daily-spend ledger is simple enough for JSON. The charge ledger has more complex state (timers, cooldown, bankruptcy cascades). Both are viable; this research doc does not pre-decide — that's the forking-realities cast's job.

**Interface design (this doc) is storage-agnostic.** The `ChargeLedger` class exposes `read()`, `deduct()`, `credit()`, `checkCooldown()`, `applyIdleRecovery()`. Whether the backing store is JSON or SQLite is an implementation detail behind this interface.

### Q3: Multi-User / Multi-Session

Phase 3 assumes single-user, single-machine. Daily cap is per-repo (`.manta/state/` is repo-local). If two sessions run simultaneously, they share the same daily-spend file — race condition is mitigated by atomic write (tmp+rename), same as all other `.manta/state/` files. Last-write-wins is acceptable for budget tracking (the worst case is a double-counted or missed entry, which the `--force` escape hatch handles).

### Q4: Timezone for Daily Reset

Daily reset uses the **machine's local midnight**. The `date` field in `daily-spend.json` uses `new Date().toISOString().slice(0, 10)` (UTC date). This is intentional — UTC avoids timezone ambiguity in audit logs. A user who casts at 11:55pm local time and again at 12:05am sees two separate days in the ledger, which matches their mental model regardless of UTC offset.

Actually — this creates confusion if the user is in UTC-5 and the "day" resets at 7pm local. **Revised:** use local date string from `Intl.DateTimeFormat` for the day boundary, but store UTC timestamps for audit. The config can optionally specify a timezone override.

## 11. Implementation Chunks (Suggested for Phase 3 Planning)

| Chunk | Scope | Dependencies |
|---|---|---|
| 3.1 | `BudgetConfig` loader + `manta limit` command | None |
| 3.2 | `DailySpendLedger` store + daily cap pre-spawn gate | 3.1 |
| 3.3 | `ChargeLedger` store (via forking-realities: sqlite vs JSON) | None |
| 3.4 | `PreSpawnGate` composition + `--dry-run` flag | 3.1, 3.2, 3.3 |
| 3.5 | `AutoDowngradeAdvisor` + interactive/non-interactive UX | 3.4 |
| 3.6 | `manta cost` + `manta charges` commands | 3.2, 3.3 |
| 3.7 | Post-cast settlement (charge adjust, daily-spend update) | 3.3, 3.4 |
| 3.8 | `manta refresh` command (cooldown reset) | 3.3 |
| 3.9 | Integration tests + e2e dogfood | All above |

Estimated total: 8-10 implementation tasks, well-suited for 2-3 forking-realities + recon-swarm casts.

## 12. Risk Assessment

| Risk | Severity | Mitigation |
|---|---|---|
| Cost estimates wildly inaccurate | Medium | Conservative estimates + `--force` escape hatch + telemetry to tune |
| Daily cap too restrictive for power users | Low | Configurable via `manta limit set daily_cap_usd` + `--force` |
| Charge system too punitive after failures | Medium | Passive recovery (30min) + `/manta refresh` + tunable in config |
| Race condition on daily-spend.json | Low | Atomic write (tmp+rename); last-write-wins acceptable |
| Auto-downgrade surprises user | Medium | `confirm: true` default; clear messaging; `--force` override |
| Config file drift from CLI defaults | Low | CLI flags always override config; config is optional |
