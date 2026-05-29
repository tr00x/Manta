# Phase 7c — Auto-cast Triggers: arm-with-dry-fire, loop-safe, budget-gated

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `manta trigger add/list/show/remove/arm/disarm/disarm-all/fire/circuit-status/circuit-reset` plus `manta install-hooks`, the `manta-hook` shim, and the bus-side trigger state stores — so that **git hooks**, **Claude Code hooks**, and **manual fire** can spawn casts *reactively*. Every reactive spawn is **disarmed by default**, requires an explicit `arm` step gated behind a mandatory `--dry-fire`, passes through `runPreSpawnGate` with `force: false` hard-coded (no bypass flag exists), and is refused before spawn if its cause-chain loops. Filesystem watchers, test-runner watchers, and CI webhooks are explicitly **deferred to Phase 8** (each needs a long-lived daemon; out of scope here).

**Posture (non-negotiable, per approach hint + research §0):** This is the highest-risk feature in Phase 7. The plan is written *guardrail-first* — every refusal path lands and is tested **before** the happy-path spawn code in the same chunk. Bias toward "no": a trigger that fails to fire is a minor annoyance; a trigger that fires when it should not can burn the daily budget in minutes or recurse infinitely.

**Architecture:** Triggers are **synchronous-on-event**, not polled. Each event source (git invoking `.git/hooks/*`, Claude Code invoking `.claude/settings.json` hooks) already runs a deterministic harness; we piggy-back on it. The harness shells out to the `manta-hook` shim, which calls `manta trigger fire-for-event`, which evaluates every matching trigger and either spawns one cast (via the *same* gate-then-spawn seam the manual `manta cast` path uses) or appends a refusal record. **No new long-running process** — the Phase 5 daemon (`packages/manta-cli/src/daemon-loop.ts:30`) is *not* extended (it is a work-queue *consumer*; triggers are *event-arrival*). New code lives behind one new bus subtree (`packages/manta-bus/src/state/triggers-*.ts`) plus one new CLI subtree (`packages/manta-cli/src/triggers/`), one new command file (`packages/manta-cli/src/commands/trigger.ts`), and one new bin entry (`packages/manta-cli/bin/manta-hook`). The cast spawn path is refactored once to expose a reusable `spawnCast` seam that both the manual CLI and the trigger fire path call with hardened options.

**Tech Stack:** TypeScript, Zod schemas, Vitest. **No new npm dependency** — `yaml@^2.6.0` is already a dependency (`packages/manta-cli/package.json:39`, added in Phase 7a; research §7 Q4 is stale on this point). Atomic-fs helpers (`atomicMutateJson` / `appendJsonLine`) already used by `@manta/bus` state stores (`packages/manta-bus/src/atomic-fs.ts`, consumed at `packages/manta-bus/src/state/casts.ts:3`). Fake clock seam from existing bus tests for deterministic debounce/cooldown/window testing.

**Research:** `docs/research/phase-7-auto-cast-triggers.md` (clone-B, cast `cast-1779977834212`, ground truth for this plan — read in full). Cross-reference Phase 7a's lockfile/ModeRegistry surface for `runtime` shape (`packages/manta-cli/src/runtime.ts:41`).

**Spec anchors:** Sec 11.1 line 470 (feature index item 3 — "Auto-cast triggers: hooks реагируют на события"); Sec 12 lines 540-541 (`/manta trigger add <event> <action>` / `/manta trigger list`).

**Sibling coordination (clone-A, Phase 7b `manta share`):** Phase 7c owns the `triggered_by` provenance contract. The `metadata.trigger` + `metadata.cause_chain` schema (Chunk 1 Task 1.1) is the frozen contract A's share-bundle `castOrigin` block must propagate verbatim (broadcast `dependency/phase-7c-triggered_by-contract`, `cast-1780019284984`). A must **not** strip `cause_chain` from a shared trigger-fired cast (audit-trail invariant). If 7c metadata field names change after this plan ships, it is a breaking change to A's bundle contract.

**Out of scope (deferred):**

| Surface | Deferred to | Why |
|---|---|---|
| Filesystem watcher source (chokidar / `fs.watch`) | Phase 8 | Long-lived daemon; cross-platform `fs.watch` quirks. Claude Code `PostToolUse:Edit` covers Claude-driven edits; user-driven edits surface via git on commit. Research §1.2 (d). |
| Test-runner watch source (vitest `--reporter=json` tail) | Phase 8 | Long-lived sidecar; duplicates IDE work; vitest JSON reporter not contract-stable across minors. Phase 7c covers "on test failure" via a `git.post-commit` trigger with a `conditions: shell` test run. Research §1.2 (b). |
| CI webhook source | Phase 8+ | Needs public ingress (ngrok/tunnel) or a polling sidecar; proper home is Manta Cloud. Research §1.2 (e). |
| `PreToolUse`-source triggers | Phase 8 | Hook has a ~2s budget; a cast spawn exceeds it. PreToolUse is for *blocking* safety hooks, not spawning. Research §1.3. |
| MCP `manta.trigger_fire` tool (clone fires a trigger) | Phase 8 | Recursive-cast territory; forbidden in Phase 0-7 (spec Sec 5; `manta-as-clone` "Forbidden — recursive cast"). Unlocks with `phantom-lance`. Research §6.7. |
| `fires.jsonl` rotation utility | Phase 8 | Generic log-rotation usable by `chargesLog` (`packages/manta-bus/src/state/paths.ts:41`) too; both grow unbounded today. Phase 7c logs every decision and accepts unbounded growth with a documented size-warning. Research §7 Q3/Q6. |
| `manta trigger lint <file>` (scope/budget smell linter) | Phase 8 | The proper fix for the headline user-DSL risk (see Risk surface). Phase 7c relies on defence-in-depth instead. Research §8. |
| Trigger templates in Manta Library | Phase 8 | Additive on top of Phase 7a library surface. Research §8. |
| Auto-downgrade on daily-cap in a trigger spawn | Never (by design) | A trigger silently downgrading its own mode is a footgun; trigger spawns always **refuse** on daily-cap, never downgrade. Research §3.1, §9. |

---

## Chunk 1 — Schemas + bus state stores (foundation, schema-first)

Lands every Zod schema and every bus-side state store **before** any code writes to them — per CLAUDE.md "Schema-first, then text" HARD RULE and research §3.6 ("the schema change ships and clears tests in the chunk *before* `manta trigger fire` writes the field"). After Chunk 1: `CastManifestSchema` accepts trigger provenance, `BudgetConfigSchema` carries `triggers.global_hourly_cap`, `TriggerDefSchema` parses the DSL, and the four trigger stores (`armed`, `fires`, `debounce`, `circuit`) read/write atomically with full tests. No CLI, no evaluation logic yet.

**Build dependency chain:** Task 1.1 (manifest metadata widening) + Task 1.2 (budget widening) + Task 1.3 (TriggerDefSchema) → workspace build → Task 1.4 (paths) → Task 1.5 / 1.6 / 1.7 / 1.8 (the four stores; independent of each other, all depend on 1.4) → Task 1.9 (cause-chain accessor on CastsStore, depends on 1.1).

~520 LOC implementation estimated. Chunk-completes when every Task 1.x is green and `pnpm gate` is clean workspace-wide.

### Task 1.1: Widen `CastManifestSchema` + `CreateCastInputSchema` with trigger provenance

**Files:**
- Modify: `packages/manta-bus/src/schema.ts:332` — add `metadata` to `CastManifestSchema`; `:349` — add same optional `metadata` to `CreateCastInputSchema`.
- Modify: `packages/manta-bus/src/schema.ts` — add `CastTriggerProvenanceSchema` immediately above `CastManifestSchema` (after `CastIdSchema` at `:233` is already defined and `CastPolicySchema`).
- Create: `packages/manta-bus/tests/cast-manifest-trigger-metadata.test.ts`
- Modify: `packages/manta-bus/src/index.ts` — re-export `CastTriggerProvenanceSchema` + inferred type `CastTriggerProvenance`.

**Why:** Loop detection (Task 3.x) walks a cast's `cause_chain` before deciding whether a trigger may spawn. That chain lives on the cast manifest. Both `CastManifestSchema` (`schema.ts:332`) and `CreateCastInputSchema` (`schema.ts:349`) are `.strict()` (`:347`) with no metadata bag today — adding an **optional** `metadata` field keeps every Phase 0-7a cast (which omits it) valid while rejecting unknown metadata keys (forward-safe). This is the frozen contract broadcast to clone-A.

**Schema (verbatim from research §3.6, adapted to current `CastIdSchema` at `schema.ts:233`):**

```ts
export const CastTriggerProvenanceSchema = z
  .object({
    trigger_name: z.string().min(2).max(48).regex(/^[a-z0-9-]+$/),
    fired_at: z.number().int().nonnegative(),
    parent_cast_id: CastIdSchema.nullable(),   // null = user-fired / outside any Manta context
  })
  .strict();

export const CastMetadataSchema = z
  .object({
    trigger: CastTriggerProvenanceSchema.optional(),
    cause_chain: z.array(z.string().min(2).max(48)).max(8).default([]),  // trigger names
  })
  .strict();

// added to CastManifestSchema (schema.ts:332) and CreateCastInputSchema (schema.ts:349):
metadata: CastMetadataSchema.optional(),
```

**Acceptance criteria:**
- `CastManifestSchema.parse(<manifest with no metadata>)` succeeds (backward-compatible — every existing cast).
- `CastManifestSchema.parse(<manifest with metadata.trigger + metadata.cause_chain>)` returns the typed object; `cause_chain` defaults to `[]` when `metadata` is present but `cause_chain` omitted.
- `CastMetadataSchema.parse(<{ trigger: {...}, cause_chain: [...], extra: 1 }>)` throws — `.strict()`.
- `CastTriggerProvenanceSchema.parse(<trigger_name: "Bad_Name">)` throws (regex: lowercase kebab only).
- `CastTriggerProvenanceSchema.parse(<trigger_name: "x">)` throws (min length 2).
- `CastTriggerProvenanceSchema.parse(<parent_cast_id: null>)` succeeds (user-fired sentinel).
- `cause_chain` of length 9 throws (`.max(8)` — backstop above the depth-3 refusal so a poisoned manifest cannot carry an unbounded chain).
- `CreateCastInputSchema.parse(<input with metadata>)` succeeds and round-trips through `CastsStore.create` (cross-checked in Task 1.9).

**Tests:**

- [ ] **Step 1: Write failing tests** — one per acceptance criterion. Reuse an existing valid-manifest fixture from `packages/manta-bus/tests/` and extend it with `metadata`.

- [ ] **Step 2: Run tests — verify FAIL** (`cd packages/manta-bus && pnpm vitest run tests/cast-manifest-trigger-metadata.test.ts`).

- [ ] **Step 3: Implement** — insert `CastTriggerProvenanceSchema` + `CastMetadataSchema` above `CastManifestSchema`; add the optional `metadata` field to both object schemas; keep `.strict()`.

- [ ] **Step 4: Re-export from `@manta/bus` index** (`packages/manta-bus/src/index.ts`).

- [ ] **Step 5: Run tests — verify PASS** + confirm no existing `@manta/bus` cast tests regress (`pnpm vitest run`).

- [ ] **Step 6: Build workspace** — `pnpm -r build` clean so downstream `@manta/cli` can import `CastTriggerProvenance`.

- [ ] **Step 7: Commit**

```
feat(bus): CastManifest trigger provenance metadata (triggered_by + cause_chain)
```

---

### Task 1.2: Widen `BudgetConfigSchema` with `triggers.global_hourly_cap`

**Files:**
- Modify: `packages/manta-bus/src/schema.ts:439` — add `triggers` object to `BudgetConfigSchema`.
- Modify: `packages/manta-cli/src/config/budget-config.ts:19` — add `triggers` to `ResolvedBudgetConfig`; `:41` — add default to `BUDGET_DEFAULTS`; `:60` — resolve in `loadBudgetConfig`.
- Modify: `packages/manta-cli/tests/config/budget-config.test.ts` (or create if absent) — assert default + override.
- Modify: `packages/manta-bus/tests/` budget schema test — assert new field parses + defaults.

**Why:** Research §3.2 mandates a **global hourly cap** spanning all triggers (default 6), on top of each trigger's own `hourly_cap`. It covers the case where many small triggers fire simultaneously and would together blow the daily budget. It belongs in the budget config (`BudgetConfigSchema` at `schema.ts:439`, `daily_cap_usd` at `:443`) because it is a budget-policy knob, resolved through the existing `loadBudgetConfig` path (`budget-config.ts:60`).

**Schema addition (`schema.ts:439`, inside the existing `.object({...})`):**

```ts
triggers: z
  .object({
    global_hourly_cap: z.number().int().positive().default(6),
  })
  .strict()
  .default({ global_hourly_cap: 6 }),
```

**`ResolvedBudgetConfig` addition (`budget-config.ts:19`):** `triggersGlobalHourlyCap: number;` and in `BUDGET_DEFAULTS` (`:41`) `triggersGlobalHourlyCap: 6`, resolved in `loadBudgetConfig` (`:60`) as `data.triggers?.global_hourly_cap ?? BUDGET_DEFAULTS.triggersGlobalHourlyCap`.

**Acceptance criteria:**
- `BudgetConfigSchema.parse(<config with no triggers key>)` succeeds; `.triggers.global_hourly_cap === 6` (default).
- `BudgetConfigSchema.parse(<triggers: { global_hourly_cap: 2 }>)` returns `2`.
- `BudgetConfigSchema.parse(<triggers: { global_hourly_cap: 0 }>)` throws (`.positive()`).
- `BudgetConfigSchema.parse(<triggers: { global_hourly_cap: 6, extra: 1 }>)` throws (`.strict()`).
- `loadBudgetConfig` on a repo with no `budget.json` returns `triggersGlobalHourlyCap: 6`.

**Tests:**

- [ ] **Step 1: Write failing tests** in both the bus schema test and the cli budget-config test.

- [ ] **Step 2: Run tests — verify FAIL.**

- [ ] **Step 3: Implement** the schema addition + the `ResolvedBudgetConfig`/`BUDGET_DEFAULTS`/`loadBudgetConfig` wiring.

- [ ] **Step 4: Run tests — verify PASS** + `pnpm -r build`.

- [ ] **Step 5: Commit**

```
feat(bus,cli): budget config triggers.global_hourly_cap (default 6)
```

---

### Task 1.3: `TriggerDefSchema` — the trigger DSL Zod schema

**Files:**
- Create: `packages/manta-bus/src/trigger-schema.ts` — all trigger-related Zod schemas + inferred types.
- Create: `packages/manta-bus/tests/trigger-schema.test.ts`
- Modify: `packages/manta-bus/src/index.ts` — re-export the schemas + types.

**Why:** The trigger YAML is the *only* user-authored, schema-validated artifact in Phase 7c — the headline risk lives here (see Risk surface). It must be strict (`additionalProperties: false` everywhere), it must enforce the mandatory `forbidden_paths`, and it must cap budgets relative to the safety block at **parse time**, not at fire time. Co-located in `@manta/bus` alongside `BudgetConfigSchema` (`schema.ts:439`) per research §2.2 so both the bus stores and the CLI validator import one parser.

**Schema (from research §2.2, made strict & cross-validated):**

```ts
// packages/manta-bus/src/trigger-schema.ts
import { z } from 'zod';
import { ModeSchema } from './schema.js';   // the 10-mode enum (schema.ts ModeSchema)

const TriggerNameSchema = z.string().regex(/^[a-z0-9-]{2,48}$/);

const EventSourceSchema = z.enum(['git', 'claude-code-hook', 'manual']);

const ConditionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('shell'), cmd: z.string().min(1), timeout_ms: z.number().int().positive().max(300000), cwd: z.string().default('${repo.root}') }).strict(),
  z.object({ type: z.literal('changed_files_gt'), value: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal('changed_files_match_glob'), glob: z.string().min(1) }).strict(),
  z.object({ type: z.literal('exit_code_eq'), value: z.number().int() }).strict(),
  z.object({ type: z.literal('env_eq'), name: z.string().min(1), value: z.string() }).strict(),
  z.object({ type: z.literal('payload_json_path_eq'), path: z.string().min(1), value: z.string().optional(), matches_glob: z.string().optional() }).strict(),
]);

const TriggerScopeSchema = z
  .object({
    allowed_paths: z.array(z.string().min(1)).min(1),
    forbidden_paths: z.array(z.string().min(1)),
    max_files_changed: z.number().int().nonnegative(),
  })
  .strict()
  .refine((s) => s.forbidden_paths.includes('.manta/state') && s.forbidden_paths.includes('secrets/'),
    { message: 'forbidden_paths MUST include both ".manta/state" and "secrets/"' });

const TriggerSafetySchema = z
  .object({
    hourly_cap: z.number().int().positive().default(3),
    per_fire_budget_usd: z.number().positive().default(3),
    loop: z
      .object({
        max_cause_chain_depth: z.number().int().positive().max(8).default(3),
        refuse_if_self_in_chain: z.boolean().default(true),
        refuse_if_any_in_chain: z.array(TriggerNameSchema).default([]),
      })
      .strict()
      .default({ max_cause_chain_depth: 3, refuse_if_self_in_chain: true, refuse_if_any_in_chain: [] }),
  })
  .strict();

const TriggerActionSchema = z
  .object({
    mode: ModeSchema,
    clones: z.number().int().positive().max(8),
    task_template: z.string().min(1),
    scope: TriggerScopeSchema,
    budget: z.object({ per_clone_usd: z.number().positive(), per_cast_usd: z.number().positive() }).strict(),
  })
  .strict();

export const TriggerDefSchema = z
  .object({
    version: z.literal(1),
    name: TriggerNameSchema,
    enabled: z.literal(false),                 // MUST be false at add-time; arm flips bus state, not YAML
    description: z.string().default(''),
    event: z
      .object({ source: EventSourceSchema, type: z.string().min(1), hook_matcher: z.string().nullable().default(null) })
      .strict(),
    conditions: z.array(ConditionSchema).default([]),
    debounce_ms: z.number().int().nonnegative().default(0),
    dedup_key: z.string().default(''),
    cooldown_s: z.number().int().nonnegative().default(300),
    safety: TriggerSafetySchema,
    action: TriggerActionSchema,
  })
  .strict()
  .refine((t) => t.action.budget.per_cast_usd <= t.safety.per_fire_budget_usd,
    { message: 'action.budget.per_cast_usd must be <= safety.per_fire_budget_usd', path: ['action', 'budget', 'per_cast_usd'] });

export type TriggerDef = z.infer<typeof TriggerDefSchema>;
```

**Acceptance criteria:**
- All three worked examples (research §2.4.1/§2.4.2/§2.4.3) parse with `fatal: false`.
- `enabled: true` throws (`z.literal(false)`) — the YAML can never self-arm; only bus `armed.json` arms.
- `forbidden_paths` omitting `.manta/state` throws via the scope `.refine`.
- `forbidden_paths` omitting `secrets/` throws.
- `action.budget.per_cast_usd: 4` with `safety.per_fire_budget_usd: 3` throws via the top-level `.refine`.
- `action.mode` outside the 10-mode enum throws (reuses `ModeSchema`).
- `name: "UPPER"` throws (regex).
- Any unknown key at any nesting level throws (`.strict()` everywhere).
- `conditions` with `type: 'unknown'` throws (discriminated union).
- `clones: 9` throws (`.max(8)` — clones cap matches `CastClonesEntry` roster sanity).
- Omitting `safety` throws (no default — safety must be explicit, per "bias toward no").

**Tests:**

- [ ] **Step 1: Write failing tests** — embed the three §2.4 examples as YAML strings, parse via `yaml.parse` then `TriggerDefSchema.parse`; one negative test per acceptance criterion.

- [ ] **Step 2: Run tests — verify FAIL** (`cd packages/manta-bus && pnpm vitest run tests/trigger-schema.test.ts`).

- [ ] **Step 3: Implement `trigger-schema.ts`** verbatim above. Import `ModeSchema` from `./schema.js` (do NOT re-derive the mode list — single source of truth).

- [ ] **Step 4: Re-export from `@manta/bus` index.**

- [ ] **Step 5: Run tests — verify PASS** + `pnpm -r build`.

- [ ] **Step 6: Commit**

```
feat(bus): TriggerDefSchema — strict trigger DSL with mandatory forbidden_paths + budget cap refine
```

---

### Task 1.4: Path resolution for the trigger state subtree

**Files:**
- Modify: `packages/manta-bus/src/state/paths.ts:4` (add fields to `BusPaths` interface) + `:24` (populate in `busPaths`).
- Modify: `packages/manta-bus/tests/state/paths.test.ts` (or equivalent) — assert the new paths resolve under `stateDir`.

**Why:** Per CLAUDE.md / Phase 0 design, clones never write `.manta/state/*` directly — only the bus does. The four trigger stores need canonical paths resolved off the single `stateDir` (`paths.ts:28`), exactly like `charges` (`:40`), `chargesLog` (`:41`), `dailySpend` (`:42`). Adding them in one place keeps path construction centralised.

**Additions to `BusPaths` (research §6.6, adapted to current `paths.ts` shape):**

```ts
readonly triggersDir: string;                          // <stateDir>/triggers
readonly triggersArmed: string;                        // <stateDir>/triggers/armed.json
readonly triggersFires: string;                        // <stateDir>/triggers/fires.jsonl
readonly triggersCircuit: string;                      // <stateDir>/triggers/circuit.json
readonly triggersDebounce: (name: string) => string;   // <stateDir>/triggers/debounce/<name>.json
```

Populate in `busPaths` (`paths.ts:24`) using `path.join(stateDir, 'triggers', …)`. The `triggersDebounce` factory validates `name` against the trigger-name regex before joining (defence against path traversal via a crafted name — refuse names containing `/`, `..`, or path separators).

**Acceptance criteria:**
- `busPaths('/repo').triggersArmed === '/repo/.manta/state/triggers/armed.json'`.
- `busPaths('/repo').triggersDebounce('test-failure-bug-hunt')` resolves under `triggers/debounce/`.
- `busPaths('/repo').triggersDebounce('../escape')` throws (path-traversal guard).
- `busPaths('/repo').triggersDebounce('a/b')` throws.

**Tests:**

- [ ] **Step 1: Write failing tests** for each path + the two traversal-guard negatives.

- [ ] **Step 2: Run tests — verify FAIL.**

- [ ] **Step 3: Implement** the `BusPaths` additions + the guarded `triggersDebounce` factory.

- [ ] **Step 4: Run tests — verify PASS** + `pnpm -r build`.

- [ ] **Step 5: Commit**

```
feat(bus): resolve .manta/state/triggers/* paths with name traversal guard
```

---

### Task 1.5: `TriggersArmedStore` — armed/disarmed/pending state machine

**Files:**
- Create: `packages/manta-bus/src/state/triggers-armed.ts`
- Create: `packages/manta-bus/tests/state/triggers-armed.test.ts`
- Modify: `packages/manta-bus/src/index.ts` — re-export `TriggersArmedStore` + `TriggerArmedStateSchema`.

**Why:** `armed.json` is the **sole source of truth** for whether a trigger may spawn (research §3.4). Even if a YAML's `enabled` were somehow `true`, the bus-side armed state wins — otherwise editing the YAML would silently re-arm. The three-state machine (`disarmed` → `pending_dry_run` → `armed`) is enforced here, not in skill text.

**Schema + interface:**

```ts
export const TriggerArmedStateSchema = z.enum(['disarmed', 'pending_dry_run', 'armed']);

const ArmedEntrySchema = z.object({
  state: TriggerArmedStateSchema,
  armed_at: z.number().int().nonnegative().nullable(),
  armed_by_dry_run_ok: z.boolean(),
  dry_run_estimate_usd: z.number().nonnegative().nullable(),
  consecutive_validation_errors: z.number().int().nonnegative().default(0),  // §3.9 — disarm after 3
}).strict();

const ArmedFileSchema = z.object({
  version: z.literal(1),
  triggers: z.record(TriggerNameSchema, ArmedEntrySchema),
}).strict();

export class TriggersArmedStore {
  constructor(paths: BusPaths, clock: Clock);
  read(): Promise<z.infer<typeof ArmedFileSchema>>;          // empty {triggers:{}} if absent
  getState(name: string): Promise<TriggerArmedState>;        // 'disarmed' if unknown
  setPendingDryRun(name: string): Promise<void>;
  arm(name: string, opts: { dryRunEstimateUsd: number }): Promise<void>;   // requires current state pending_dry_run
  disarm(name: string): Promise<void>;                       // idempotent
  disarmAll(): Promise<string[]>;                            // returns names flipped; panic button
  recordValidationError(name: string): Promise<{ disarmed: boolean }>;  // disarms at 3 consecutive
  clearValidationErrors(name: string): Promise<void>;
}
```

State transitions enforced inside the store via `atomicMutateJson` (`packages/manta-bus/src/atomic-fs.ts`, pattern from `casts.ts:40`): `arm()` throws `TriggerStateError('illegal_transition')` unless current state is `pending_dry_run`. `disarm()` / `disarmAll()` always succeed (panic must never throw).

**Acceptance criteria:**
- Fresh store: `getState('x') === 'disarmed'`.
- `setPendingDryRun('x')` then `getState` → `pending_dry_run`.
- `arm('x', {dryRunEstimateUsd: 2.9})` from `pending_dry_run` → `armed`, `armed_at` set, `armed_by_dry_run_ok: true`.
- `arm('x', …)` from `disarmed` throws `illegal_transition` (cannot skip dry-run).
- `disarm('x')` from any state → `disarmed`; idempotent (twice is safe).
- `disarmAll()` flips all armed/pending triggers to `disarmed`, returns the flipped names, never throws.
- `recordValidationError` three times consecutively returns `{ disarmed: true }` on the third and sets state `disarmed`; `clearValidationErrors` resets the counter.
- 10 parallel `disarm` calls (Promise.all) all succeed; final state consistent (atomic-mutate serialisation).

**Tests:**

- [ ] **Step 1: Write failing tests** — fake clock + per-test tmp `stateDir`; one per acceptance criterion incl. the concurrency test.

- [ ] **Step 2: Run tests — verify FAIL** (`cd packages/manta-bus && pnpm vitest run tests/state/triggers-armed.test.ts`).

- [ ] **Step 3: Implement** using `atomicMutateJson`; `TriggerStateError extends Error` with discriminated `code`.

- [ ] **Step 4: Re-export from index.**

- [ ] **Step 5: Run tests — verify PASS.**

- [ ] **Step 6: Commit**

```
feat(bus): TriggersArmedStore — disarmed/pending_dry_run/armed state machine + panic disarm-all
```

---

### Task 1.6: `TriggerFiresLog` — append-only audit + sliding-window counters

**Files:**
- Create: `packages/manta-bus/src/state/triggers-fires.ts`
- Create: `packages/manta-bus/tests/state/triggers-fires.test.ts`
- Modify: `packages/manta-bus/src/index.ts` — re-export `TriggerFiresLog` + `TriggerFireRecordSchema` + `TriggerRefusalReasonSchema`.

**Why:** `fires.jsonl` (research §3.8) is the single audit record of every trigger evaluation regardless of outcome. It also backs the sliding-window `hourly_cap` and `cooldown_s` counters (research §3.2) and the `list --verbose` statistics (§5.3). Append-only via the existing `appendJsonLine` pattern (same as `chargesLog`, `paths.ts:41`).

**Schema:**

```ts
export const TriggerRefusalReasonSchema = z.enum([
  'disarmed', 'pending_dry_run', 'debounce_active', 'dedup_hit', 'cooldown_active',
  'hourly_cap_exhausted', 'global_hourly_cap_exhausted', 'cause_chain_depth_exceeded',
  'loop_self_in_chain', 'loop_listed_in_chain', 'budget_gate_failed', 'circuit_open',
  'condition_failed', 'validation_error',
]);

export const TriggerFireRecordSchema = z.object({
  ts: z.number().int().nonnegative(),
  trigger: TriggerNameSchema,
  event_source: EventSourceSchema,
  event_type: z.string(),
  decision: z.enum(['spawned', 'refused']),
  reason: TriggerRefusalReasonSchema.optional(),     // present iff refused
  cast_id: CastIdSchema.optional(),                  // present iff spawned
  parent_cast_id: CastIdSchema.nullable().optional(),
  cause_chain: z.array(z.string()).default([]),
  cost_estimate_usd: z.number().nonnegative().optional(),
  dedup_key_hash: z.string().optional(),
  payload_excerpt: z.record(z.unknown()).optional(),
}).strict();

export class TriggerFiresLog {
  constructor(paths: BusPaths, clock: Clock);
  append(record: Omit<TriggerFireRecord, 'ts'>): Promise<void>;     // stamps ts from clock
  /** All records for `name` within the last `windowMs`. */
  recentFor(name: string, windowMs: number): Promise<TriggerFireRecord[]>;
  /** Count of `spawned`-decision records across ALL triggers in last windowMs (global cap). */
  globalSpawnedSince(windowMs: number): Promise<number>;
  /** Count of any-decision fires for `name` in last windowMs (hourly_cap counts all fires). */
  fireCountFor(name: string, windowMs: number): Promise<number>;
  /** Most recent `spawned` record for `name`, or null (cooldown anchor). */
  lastSpawnedFor(name: string): Promise<TriggerFireRecord | null>;
  /** Tail for `list --verbose`. */
  tail(name: string, n: number): Promise<TriggerFireRecord[]>;
}
```

**Note (cooldown vs hourly_cap windowing):** `cooldown_s` measures gap between *spawned* casts (`lastSpawnedFor`); `hourly_cap` counts *all fires* in the last 3600s (`fireCountFor`); the global cap counts *spawned* across all triggers (`globalSpawnedSince`). This distinction is from research §3.2 and is load-bearing — the fire orchestrator (Task 3.x) relies on it.

**Acceptance criteria:**
- `append` stamps `ts` from the injected clock; record validates against schema before write (throws on invalid shape — defence against a buggy caller writing junk to the audit log).
- `recentFor('x', 3600_000)` returns only records within the window, oldest-first.
- `globalSpawnedSince` counts only `decision: 'spawned'` across all trigger names.
- `fireCountFor` counts both `spawned` and `refused` for the named trigger.
- `lastSpawnedFor` returns null when the trigger has only refusals.
- `tail('x', 5)` returns the last 5 records for `x` newest-first.
- A `refused` record with no `reason` fails schema (reason required on refusal — enforced by caller contract; test the schema directly with a `.superRefine` cross-check OR document the caller must always pass reason). *(Implementation note: add a `.superRefine` to `TriggerFireRecordSchema` requiring `reason` present iff `decision === 'refused'` and `cast_id` present iff `decision === 'spawned'`.)*

**Tests:**

- [ ] **Step 1: Write failing tests** — fake clock; append a sequence with controlled timestamps; assert each window query.

- [ ] **Step 2: Run tests — verify FAIL.**

- [ ] **Step 3: Implement** using `appendJsonLine` + a tail-read that parses each line, skipping (and counting) any unparseable line defensively rather than throwing on a corrupt audit log.

- [ ] **Step 4: Re-export from index.**

- [ ] **Step 5: Run tests — verify PASS.**

- [ ] **Step 6: Commit**

```
feat(bus): TriggerFiresLog — append-only audit + sliding-window cap/cooldown counters
```

---

### Task 1.7: `TriggerDebounceStore` — per-trigger debounce window

**Files:**
- Create: `packages/manta-bus/src/state/triggers-debounce.ts`
- Create: `packages/manta-bus/tests/state/triggers-debounce.test.ts`
- Modify: `packages/manta-bus/src/index.ts` — re-export.

**Why:** Debounce (research §3.3) collapses bursts: when an event arrives, record `{ event_at, payload }`; if another arrives within `debounce_ms`, overwrite (keep latest). On a fire evaluation, if the window has not expired, update-and-skip; if expired, proceed with the most recent payload. The per-trigger file lives at `triggersDebounce(name)` (Task 1.4).

**Interface:**

```ts
const DebounceEntrySchema = z.object({
  last_event_at: z.number().int().nonnegative(),
  pending_payload: z.record(z.unknown()),
}).strict();

export class TriggerDebounceStore {
  constructor(paths: BusPaths, clock: Clock);
  /**
   * Record an incoming event. Returns:
   *  - { fire: false } if within an active debounce window (caller exits 0, no spawn).
   *  - { fire: true, payload } if no active window OR window expired (caller proceeds).
   */
  observe(name: string, payload: Record<string, unknown>, debounceMs: number): Promise<{ fire: boolean; payload: Record<string, unknown> }>;
  clear(name: string): Promise<void>;   // called after a spawn so the next event starts fresh
}
```

`observe` semantics (single CLI invocation per event, research §3.3): read `<name>.json`; if absent or `clock.now() - last_event_at >= debounceMs` → write `{last_event_at: now, pending_payload: payload}` and return `{fire: true, payload}` (the just-arrived payload IS the most-recent); else overwrite `last_event_at`+`pending_payload` and return `{fire: false}`. `debounceMs === 0` always returns `{fire: true}` (no debounce) without touching disk.

**Acceptance criteria:**
- `debounceMs: 0` → always `{fire: true}`, no file written.
- First event with `debounceMs: 5000` → `{fire: true}`.
- Second event 1s later (clock advanced 1000) → `{fire: false}` and stored payload is the second event's.
- Event after window expiry (clock advanced ≥ 5000) → `{fire: true}` with the latest payload.
- `clear` removes the file; subsequent `observe` starts fresh.

**Tests:**

- [ ] **Step 1: Write failing tests** with a controllable fake clock.

- [ ] **Step 2: Run tests — verify FAIL.**

- [ ] **Step 3: Implement** using `atomicMutateJson` for the read-modify-write.

- [ ] **Step 4: Re-export from index.**

- [ ] **Step 5: Run tests — verify PASS.**

- [ ] **Step 6: Commit**

```
feat(bus): TriggerDebounceStore — collapse event bursts within debounce_ms
```

---

### Task 1.8: `TriggerCircuitStore` — global circuit breaker

**Files:**
- Create: `packages/manta-bus/src/state/triggers-circuit.ts`
- Create: `packages/manta-bus/tests/state/triggers-circuit.test.ts`
- Modify: `packages/manta-bus/src/index.ts` — re-export.

**Why:** Research §3.7 — the hard global breaker. Trips on: (a) any 3 distinct triggers refusing for *budget* reasons in a 10-minute window, or (b) a single cause-chain hitting `max_cause_chain_depth` twice in 5 minutes. When open, all triggers are forced `disarmed`, a top-level `blocker` is broadcast, and `manta status` shows a banner. The only way out is `manta trigger circuit-reset`.

**Interface:**

```ts
const CircuitFileSchema = z.object({
  version: z.literal(1),
  open: z.boolean(),
  opened_at: z.number().int().nonnegative().nullable(),
  opened_reason: z.string().nullable(),
  budget_refusals: z.array(z.object({ trigger: TriggerNameSchema, ts: z.number().int() }).strict()).default([]),
  depth_breaches: z.array(z.object({ chain_head: z.string(), ts: z.number().int() }).strict()).default([]),
}).strict();

export class TriggerCircuitStore {
  constructor(paths: BusPaths, clock: Clock);
  isOpen(): Promise<boolean>;
  /** Record a budget refusal; returns {tripped:true} if this trips the breaker. */
  recordBudgetRefusal(trigger: string): Promise<{ tripped: boolean }>;
  /** Record a depth breach; returns {tripped:true} if this trips it. */
  recordDepthBreach(chainHead: string): Promise<{ tripped: boolean }>;
  reset(reason: string): Promise<void>;   // circuit-reset; logs intent
}
```

Trip rule (a): after recording, count *distinct* trigger names in `budget_refusals` within last 600_000ms; if ≥ 3 → set `open: true`. Trip rule (b): count `depth_breaches` with same `chain_head` within last 300_000ms; if ≥ 2 → `open: true`. Both prune entries older than their window on each record.

**Acceptance criteria:**
- Fresh store: `isOpen() === false`.
- 3 budget refusals from 3 distinct triggers within 600s → `{tripped: true}` on the third; `isOpen()` true.
- 3 budget refusals from the *same* trigger → not tripped (distinct-name rule).
- 2 depth breaches with same `chain_head` within 300s → tripped on the second.
- Refusals/breaches aged beyond their window are pruned and do not count.
- `reset('manual')` sets `open: false`, clears windows, writes `opened_reason: null`.

**Tests:**

- [ ] **Step 1: Write failing tests** — fake clock, exercise both trip rules + the distinct-name and pruning behaviours.

- [ ] **Step 2: Run tests — verify FAIL.**

- [ ] **Step 3: Implement** with `atomicMutateJson`.

- [ ] **Step 4: Re-export from index.**

- [ ] **Step 5: Run tests — verify PASS.**

- [ ] **Step 6: Commit**

```
feat(bus): TriggerCircuitStore — global breaker on budget-refusal burst + depth-breach repeat
```

---

### Task 1.9: `CastsStore.getCauseChain` accessor + `create` accepts metadata

**Files:**
- Modify: `packages/manta-bus/src/state/casts.ts:33` (`create` already accepts `CreateCastInput`; confirm metadata round-trips after Task 1.1) + add `getCauseChain` method.
- Modify: `packages/manta-bus/tests/state/casts.test.ts` — add metadata round-trip + `getCauseChain` tests.

**Why:** Loop detection (Task 3.x) needs to read a parent cast's `cause_chain` to compose the child's. `CastsStore.create` (`casts.ts:33`) writes via `atomicMutateJson` (`:40`) and after Task 1.1 the `CreateCastInput` carries optional `metadata` — no algorithmic change to `create`, just verify it persists. Add a thin read accessor.

**Addition:**

```ts
// casts.ts — new method on CastsStore
async getCauseChain(castId: CastId): Promise<string[]> {
  const manifest = await this.get(castId);     // existing get
  return manifest?.metadata?.cause_chain ?? [];
}
/** Returns the parent's trigger name (for chain composition), or null. */
async getTriggerName(castId: CastId): Promise<string | null> {
  const manifest = await this.get(castId);
  return manifest?.metadata?.trigger?.trigger_name ?? null;
}
```

**Acceptance criteria:**
- `create` with `metadata.cause_chain: ['a','b']` then `get` returns the manifest with that chain intact.
- `getCauseChain(<id with metadata>)` returns `['a','b']`.
- `getCauseChain(<id with no metadata>)` returns `[]` (not throw).
- `getCauseChain(<unknown id>)` returns `[]`.
- `getTriggerName` returns the trigger name when present, null otherwise.

**Tests:**

- [ ] **Step 1: Write failing tests.**

- [ ] **Step 2: Run tests — verify FAIL.**

- [ ] **Step 3: Implement** the two accessors.

- [ ] **Step 4: Run tests — verify PASS** + `pnpm gate`.

- [ ] **Step 5: Commit**

```
feat(bus): CastsStore.getCauseChain + getTriggerName for loop-detection chain composition
```

---

### Chunk 1 complete when

- All Task 1.x commits land on the chunk-1 branch.
- `pnpm gate` clean (`pnpm typecheck && pnpm lint && pnpm test`) — verified by self-run, not on subagent's word (CLAUDE.md).
- Every new schema is `.strict()` and every new store uses the existing atomic-fs primitives (no new mutex impl).
- `@manta/bus` index re-exports all new schemas, types, and store classes.

---

## Chunk 2 — Reusable `spawnCast` seam + `BusContext` wiring

Refactors the cast spawn path so the gate-then-spawn flow is callable by both the manual CLI and the trigger fire path, with `force` hard-codeable. Wires the four new stores into `Runtime`/`BusContext`. This chunk lands **before** the fire orchestrator so the orchestrator has a hardened seam to call. No trigger evaluation logic yet.

**Build dependency chain:** Task 2.1 (wire stores into runtime) → Task 2.2 (extract `spawnCast`) → Task 2.3 (cast-manifest writes metadata).

~180 LOC (mostly moved code) estimated. Chunk-completes when `pnpm gate` clean and the existing `manta cast` behaviour is byte-for-byte unchanged (regression-guarded).

### Task 2.1: Wire trigger stores into `Runtime`

**Files:**
- Modify: `packages/manta-cli/src/runtime.ts:41` (add fields to `Runtime` interface) + `:86`-`:87` (construct alongside `charges`/`dailySpend`).
- Modify: `packages/manta-cli/tests/runtime.test.ts` (or equivalent) — assert the new stores are present.

**Why:** `Runtime` already constructs `charges` (`runtime.ts:86`) and `dailySpend` (`:87`) from `paths` + `clock`. The four trigger stores follow the identical pattern; the fire orchestrator + CLI commands consume them through `runtime`.

**Additions to `Runtime` (`runtime.ts:41`):**

```ts
triggersArmed: TriggersArmedStore;
triggerFires: TriggerFiresLog;
triggerDebounce: TriggerDebounceStore;
triggerCircuit: TriggerCircuitStore;
```

Construct in `createRuntime` next to `charges`/`dailySpend` (`:86`): `new TriggersArmedStore(paths, clock)`, etc.

**Acceptance criteria:**
- A constructed `Runtime` exposes all four trigger stores, each backed by the repo's `stateDir`.
- Existing `Runtime` fields (`lockfile` `:47`, `localStore` `:48`, `charges` `:86`, `dailySpend` `:87`) unchanged.

**Tests:**

- [ ] **Step 1: Write failing test** asserting the four stores exist on a freshly created runtime.

- [ ] **Step 2: Run — verify FAIL.**

- [ ] **Step 3: Implement** the interface + constructor wiring.

- [ ] **Step 4: Run — verify PASS** + `pnpm -r build`.

- [ ] **Step 5: Commit**

```
feat(cli): wire TriggersArmed/Fires/Debounce/Circuit stores into Runtime
```

---

### Task 2.2: Extract `spawnCast` seam from `runCastCommand`

**Files:**
- Modify: `packages/manta-cli/src/commands/cast.ts:236` — extract the gate-then-spawn flow (currently inline in `runCastCommand`, gate call at `:420`, `force` at `:427`) into an exported `spawnCast(rt, opts)`.
- Modify: `packages/manta-cli/src/index.ts` — re-export `spawnCast` + `SpawnCastOptions` + `CastSpawnResult`.
- Modify: `packages/manta-cli/tests/commands/cast.test.ts` — add a direct `spawnCast` unit test; assert `runCastCommand` still passes all existing tests (regression).

**Why:** Research §6.4 — the trigger fire path must call into the *existing* gate-then-spawn flow with `force: false` hard-coded and `metadata.trigger` populated. Today that flow is inline in `runCastCommand` (`cast.ts:236`), with `runPreSpawnGate` invoked at `:420` and `force: opts.force ?? false` at `:427`. Extracting it into `spawnCast` lets both callers share one code path — **no second spawn implementation**, so the budget gate cannot be bypassed by the trigger path simply by forgetting to call it.

**Exported interface:**

```ts
// packages/manta-cli/src/commands/cast.ts (new export)
export interface SpawnCastOptions {
  mode: string;
  clones: number;
  /** Per-clone task; trigger path passes the rendered task_template. */
  task: string;
  scope: { allowedPaths: string[]; forbiddenPaths: string[]; maxFilesChanged: number };
  budget: { perCloneUsd: number; perCastUsd: number };
  /** HARD: trigger fire path passes false; never settable to true by a trigger. */
  force: boolean;
  /** Provenance written onto the cast manifest (Task 2.3). Null for manual casts. */
  triggerProvenance: CastTriggerProvenance | null;
  causeChain: string[];
  /** When set, the pre-spawn-gate reporter emits under `trigger.gate.*` (research §6.4). */
  triggerName?: string;
}
export interface CastSpawnResult { castId: string; spawnedClones: string[]; estimatedCostUsd: number; }
export async function spawnCast(rt: Runtime, opts: SpawnCastOptions): Promise<CastSpawnResult>;
```

`runCastCommand` becomes a thin wrapper: parse CLI opts → call `spawnCast` with `triggerProvenance: null`, `causeChain: []`, `force: opts.force ?? false` (manual `--force` still allowed for the *human* path). The mode-validation (`modeRegistry.has` at `cast.ts:275`), the gate call (`:420`), and the spawn (`spawnClone` at `clone-spawner.ts:92` / `runClaudeCli` at `:281`) move into `spawnCast` unchanged.

**Acceptance criteria:**
- All existing `runCastCommand` tests pass unchanged (zero behavioural regression — the seam is a pure refactor).
- `spawnCast(rt, {force: false, …})` with a daily-cap-exceeding cost is refused by `runPreSpawnGate` (same as `runCastCommand` today).
- `spawnCast` with `triggerName` set causes the gate reporter to emit `trigger.gate.*` channel events (assert via the existing reporter spy used in cast tests).
- `spawnCast` with `triggerProvenance` populated writes it to the manifest (cross-checked in Task 2.3).

**Tests:**

- [ ] **Step 1: Write `spawnCast` unit tests** + confirm the existing cast suite still references `runCastCommand`.

- [ ] **Step 2: Run — verify FAIL** (new tests fail; existing pass).

- [ ] **Step 3: Implement the extraction** — move the gate-then-spawn block; `runCastCommand` delegates. Re-grep `cast.ts:236`/`:275`/`:420`/`:427` before editing (lines drift).

- [ ] **Step 4: Run full cast suite — verify PASS** (regression gate).

- [ ] **Step 5: Re-export from index** + `pnpm -r build`.

- [ ] **Step 6: Commit**

```
refactor(cli): extract spawnCast seam from runCastCommand (shared by manual + trigger paths)
```

---

### Task 2.3: `spawnCast` writes trigger provenance onto the cast manifest

**Files:**
- Modify: `packages/manta-cli/src/commands/cast.ts` — where the `CreateCastInput` is built before `CastsStore.create`, populate `metadata` from `opts.triggerProvenance`/`opts.causeChain`.
- Modify: `packages/manta-cli/tests/commands/cast.test.ts` — assert the manifest carries metadata when provenance is passed, and omits it (no `metadata` key) when null.

**Why:** Closes the loop with Task 1.1. The cast manifest is the durable record the loop detector reads (`CastsStore.getCauseChain`, Task 1.9). Manual casts must continue to write *no* `metadata` (backward-compatible); trigger casts write the full provenance.

**Acceptance criteria:**
- `spawnCast(rt, {triggerProvenance: null, causeChain: []})` produces a manifest with **no** `metadata` key.
- `spawnCast(rt, {triggerProvenance: {trigger_name:'t', fired_at:123, parent_cast_id:null}, causeChain:['t']})` produces a manifest whose `metadata.trigger.trigger_name === 't'` and `metadata.cause_chain === ['t']`.
- `CastsStore.getCauseChain(result.castId)` returns `['t']` after the spawn.

**Tests:**

- [ ] **Step 1: Write failing tests.**

- [ ] **Step 2: Run — verify FAIL.**

- [ ] **Step 3: Implement** the conditional metadata population.

- [ ] **Step 4: Run — verify PASS** + `pnpm gate`.

- [ ] **Step 5: Commit**

```
feat(cli): spawnCast writes trigger provenance + cause_chain onto cast manifest
```

---

### Chunk 2 complete when

- `pnpm gate` clean.
- `manta cast <mode>` manual behaviour is regression-identical (existing cast suite green, no test edits except additions).
- `spawnCast` is the single gate-then-spawn entry; `runCastCommand` delegates to it.

---

## Chunk 3 — Trigger evaluator, validator, renderer, fire orchestrator (guardrails first)

The heart of Phase 7c. Lands the loader, the strict template renderer, the condition evaluator, and the **fire orchestrator** — which sequences every guardrail (debounce → dedup → cooldown → caps → circuit → cause-chain → budget gate) *before* it calls `spawnCast`. **Refusal paths are written and tested before the spawn path** (research §0 posture). All evaluation is pure-functional over injected stores + clock, so every guardrail is unit-testable without spawning a real process.

**Build dependency chain:** Task 3.1 (loader) + Task 3.2 (renderer) + Task 3.3 (condition evaluator) → Task 3.4 (fire orchestrator, consumes all three + Chunk 2 `spawnCast` + Chunk 1 stores).

~620 LOC. Chunk-completes when `pnpm gate` clean and the orchestrator's refusal matrix is exhaustively tested.

### Task 3.1: Trigger loader — `.manta/triggers/<name>.yaml`

**Files:**
- Create: `packages/manta-cli/src/triggers/loader.ts`
- Create: `packages/manta-cli/tests/triggers/loader.test.ts`

**Why:** Loads + parses a single trigger YAML (mirrors `parseTasksFile` at `packages/manta-cli/src/spawner/tasks-file.ts:25`, the project's existing YAML-load precedent). Triggers are **not** auto-discovered on `git pull` — `add` takes an explicit path, `fire-for-event` lists `.manta/triggers/*.yaml` only for matching enabled triggers (research §3.9 — explicit-add is a defence layer).

**Interface:**

```ts
export interface LoadedTrigger { def: TriggerDef; path: string; }
export function loadTriggerFromFile(file: string): LoadedTrigger;     // throws TriggerLoadError on read/parse/schema fail
export function loadAllTriggers(repoRoot: string): LoadedTrigger[];   // reads .manta/triggers/*.yaml; skips+warns on invalid, never throws
export function triggerYamlPath(repoRoot: string, name: string): string;  // .manta/triggers/<name>.yaml, name-guarded
```

`loadTriggerFromFile` reads, `yaml.parse`, then `TriggerDefSchema.parse`. `loadAllTriggers` globs `.manta/triggers/*.yaml`; a single malformed file does not break evaluation of the others (logs a warning, skips) — a corrupt trigger must not silently disarm the rest by crashing the evaluator.

**Acceptance criteria:**
- `loadTriggerFromFile(<valid yaml>)` returns `{def, path}`.
- `loadTriggerFromFile(<missing file>)` throws `TriggerLoadError('cannot_read')`.
- `loadTriggerFromFile(<invalid yaml syntax>)` throws `TriggerLoadError('parse_error')`.
- `loadTriggerFromFile(<schema violation>)` throws `TriggerLoadError('schema_error')` with the Zod path.
- `loadAllTriggers` on a dir with 2 valid + 1 malformed returns the 2 valid, logs the malformed.
- `triggerYamlPath(repo, '../escape')` throws (name guard).

**Tests:**

- [ ] **Step 1: Write failing tests** with temp YAML fixtures (valid + each failure mode).

- [ ] **Step 2: Run — verify FAIL.**

- [ ] **Step 3: Implement** reusing `yaml` (`package.json:39`) + `TriggerDefSchema`.

- [ ] **Step 4: Run — verify PASS.**

- [ ] **Step 5: Commit**

```
feat(cli): trigger YAML loader (single-file + dir-glob, malformed-skips-not-crashes)
```

---

### Task 3.2: Template renderer — fixed-grammar, NOT Turing-complete

**Files:**
- Create: `packages/manta-cli/src/triggers/renderer.ts`
- Create: `packages/manta-cli/tests/triggers/renderer.test.ts`

**Why:** Research §2.3 — substitution is fixed-grammar with no conditionals, loops, or shell substitution. **Critical safety property (T5, research §3.0):** substitutions render ONLY into `task_template` and `dedup_key` — they are **never** interpolated into `conditions: shell:` `cmd` strings (conditions are evaluated *before* substitution against the raw payload). This task implements the renderer; Task 3.3/3.4 enforce that conditions never see rendered output.

**Grammar (allowed expressions only):**
- `${event.<field>}` — payload field as string. Unknown field → empty string + a collected warning.
- `${event.<field> | <filter>}` — one pipe filter. Allowed: `join: ', '`, `truncate: <n>`, `default: '<s>'`. Unknown filter → render error.
- `${trigger.name}`, `${trigger.cause_chain}` (JSON-encoded array), `${repo.root}`.
- Anything else (nested `${}`, multiple pipes, function calls) → `RenderError`.

**Interface:**

```ts
export interface RenderContext { event: Record<string, unknown>; triggerName: string; causeChain: string[]; repoRoot: string; }
export interface RenderResult { text: string; warnings: string[]; }
export function renderTemplate(template: string, ctx: RenderContext): RenderResult;  // throws RenderError on bad grammar
```

The renderer is a single-pass regex tokeniser (`/\$\{([^}]+)\}/g`) with a closed dispatch table; it does **not** `eval`, does not call any shell, and treats all values as strings post-render.

**Acceptance criteria:**
- `${event.sha}` with `{sha:'abc'}` → `'abc'`.
- `${event.files | join: ', '}` with `{files:['a','b']}` → `'a, b'`.
- `${event.msg | truncate: 4}` with `{msg:'hello'}` → `'hell'`.
- `${event.missing | default: 'n/a'}` → `'n/a'`.
- `${event.unknown}` → `''` + a warning containing `unknown`.
- `${trigger.name}` → the trigger name; `${trigger.cause_chain}` → `'["a","b"]'`.
- `${event.x | bogus: 1}` throws `RenderError`.
- `${ event.x ; rm -rf $HOME }` throws `RenderError` (no shell grammar).
- A template with no `${}` returns the literal string, no warnings.
- Rendering does NOT execute anything — assert (e.g.) a payload value `'; touch /tmp/pwned'` renders as a literal string and no file is created.

**Tests:**

- [ ] **Step 1: Write failing tests** — table-driven over the grammar + the injection-safety assertion.

- [ ] **Step 2: Run — verify FAIL.**

- [ ] **Step 3: Implement** the tokeniser + closed filter table.

- [ ] **Step 4: Run — verify PASS.**

- [ ] **Step 5: Commit**

```
feat(cli): fixed-grammar trigger template renderer (no shell, no eval, injection-safe)
```

---

### Task 3.3: Condition evaluator

**Files:**
- Create: `packages/manta-cli/src/triggers/conditions.ts`
- Create: `packages/manta-cli/tests/triggers/conditions.test.ts`

**Why:** Conditions (research §2.2) gate whether a matched event proceeds. ALL conditions must pass (AND); empty = always. **Safety (T5):** conditions evaluate against the **raw payload**, never rendered templates — a `shell` condition's `cmd` is the author's literal string, executed via the existing process-spawn helper with the payload available as env (`MANTA_EVENT_*`), NOT string-interpolated. The `shell` condition is the one place a trigger runs author-supplied shell; it is sandboxed only by the OS user account (documented limitation, Risk surface).

**Interface:**

```ts
export interface ConditionContext { payload: Record<string, unknown>; repoRoot: string; lastExitCode: number | null; runShell: ShellRunner; }
export interface ShellRunner { run(cmd: string, opts: { cwd: string; timeoutMs: number; env: Record<string, string> }): Promise<{ exitCode: number }>; }
export async function evaluateConditions(conditions: TriggerCondition[], ctx: ConditionContext): Promise<{ pass: boolean; failedIndex: number | null; lastExitCode: number | null }>;
```

**ShellRunner production implementation (review-fix — pin the safe API):**

The default `ShellRunner` (`packages/manta-cli/src/triggers/shell-runner.ts`, instantiated only inside `runTriggerFire`, never exported as a public surface) MUST use one of:

```ts
import { execa } from 'execa';
const r = await execa(cmd, [], { shell: true, cwd, timeout: timeoutMs, env, reject: false });
return { exitCode: r.exitCode ?? -1 };
```

OR the equivalent `spawn` form (`child_process.spawn('sh', ['-c', cmd], { cwd, env, …})` with stdout/stderr drained). **Never `exec(cmd)` / `execSync(cmd)`** — they buffer + are documented-vulnerable to RCE if the implementer ever interpolates payload into `cmd`. With `shell: true` the user's literal `cmd` runs through `/bin/sh`, the payload arrives ONLY via `env` (env keys are sanitized below), and the implementer cannot accidentally let the payload influence the shell parse tree.

**`MANTA_EVENT_*` env key sanitization (mandatory):**

When building the `env` map for `runShell.run`, every key derived from the payload MUST be sanitized:
- Take the payload field name, uppercase it.
- Replace any character not matching `/^[A-Z0-9_]+$/` with `_`.
- Reject (do not pass) keys that, after sanitization, are zero-length or collide with existing manta env vars (`MANTA_BUS_*`, `MANTA_CLONE_ID`, etc. — fail-closed by maintaining an explicit denylist constant).
- VALUES are passed verbatim — sh quoting is the operator's responsibility inside the trigger `cmd` (document this in the user guide; recommend `"${MANTA_EVENT_FOO:-}"` style).

This pins the one production-shell-execution path against argv-injection and key-collision attacks; it also keeps the test seam (`runShell` injectable) trivially fakeable with no need for actual process spawn in unit tests.

Per-type evaluation:
- `shell` — `runShell.run(cmd, {cwd, timeoutMs, env: {...MANTA_EVENT_<KEY>}})`; pass iff `exitCode === 0`; records `lastExitCode` for a following `exit_code_eq`.
- `changed_files_gt` — `(payload.changed_files_count ?? payload.changed_files?.length ?? 0) > value`.
- `changed_files_match_glob` — any `payload.changed_files[]` matches glob (use a small glob matcher; no new dep — reuse the project's existing minimatch-equivalent if present, else a tiny matcher).
- `exit_code_eq` — `ctx.lastExitCode === value` (relies on a preceding `shell`).
- `env_eq` — `process.env[name] === value`.
- `payload_json_path_eq` — resolve a `$.a.b` path against payload; `value` exact-match OR `matches_glob`.

`runShell` is injected (fake in tests) — no real process spawn in unit tests.

**Acceptance criteria:**
- Empty conditions → `{pass: true}`.
- `shell` exit 0 → pass; exit 1 → `{pass: false, failedIndex: 0}`.
- `shell` (exit 1) followed by `exit_code_eq: 1` → both pass (the failure-then-check idiom from research §2.4.1).
- `changed_files_gt: 100` with `changed_files_count: 150` → pass; `50` → fail.
- `changed_files_match_glob: 'packages/**/security/**'` matches a security path, rejects a non-match.
- `payload_json_path_eq` with `path: '$.tool_input.file_path'` + `matches_glob` matches the §2.4.3 example.
- A `shell` cmd that times out → exitCode non-zero → fail (no hang; the timeout is honoured by the injected runner contract).
- Conditions never receive rendered template text (assert the cmd passed to `runShell` is the author's literal string).

**Tests:**

- [ ] **Step 1: Write failing tests** with a fake `ShellRunner`.

- [ ] **Step 2: Run — verify FAIL.**

- [ ] **Step 3: Implement** per-type dispatch.

- [ ] **Step 4: Run — verify PASS.**

- [ ] **Step 5: Commit**

```
feat(cli): trigger condition evaluator (shell/changed-files/exit-code/env/json-path, AND-semantics)
```

---

### Task 3.4: Fire orchestrator — the guardrail sequence

**Files:**
- Create: `packages/manta-cli/src/triggers/fire.ts`
- Create: `packages/manta-cli/tests/triggers/fire.test.ts`

**Why:** This is where every refusal path converges. The orchestrator decides, for one trigger against one payload, whether to spawn — running the guardrails **in the order research §4.2 specifies**, recording every decision to `fires.jsonl`, and only at the very end calling `spawnCast` with `force: false` hard-coded. There is no `--bypass-gate` flag and no code path that sets `force: true` from a trigger (research §3.1).

**Interface:**

```ts
export interface FireTriggerInput {
  trigger: TriggerDef;
  payload: Record<string, unknown>;
  /** Parent cast id from MANTA_CAST_ID env (Claude session spawned by a clone) or null. */
  parentCastId: string | null;
  isDryFire: boolean;     // arm's --dry-fire: run full eval EXCEPT actual spawn
}
export interface FireDecision { decision: 'spawned' | 'refused'; reason?: TriggerRefusalReason; castId?: string; }
export async function fireTrigger(rt: Runtime, input: FireTriggerInput, deps: { runShell: ShellRunner; now: () => number }): Promise<FireDecision>;
```

**Guardrail sequence (each refusal appends to `fires.jsonl` and returns; ordering is load-bearing — cheapest/safest checks first):**

0. **Schema validation loader-side (review-fix — wire `recordValidationError`):** Before the orchestrator runs, the trigger was loaded from disk by Task 3.1's `loadAllTriggers` which Zod-parses each `.manta/triggers/<name>.yaml`. On parse failure the loader MUST:
   - Append a `fires.jsonl` record `{ trigger_name: name, ts: now, decision: 'refused', reason: 'validation_error', validation_message: <zod issue summary> }` via `rt.triggerFires.appendRefusal(...)`.
   - Call `rt.triggersArmed.recordValidationError(name)`; if the return is `{ disarmed: true }` (the disarm-after-N policy from Task 1.5), also append a `{ decision: 'disarmed_by_validation', ... }` record.
   - **NOT** invoke `fireTrigger` for the invalid trigger. The trigger is excluded from the loaded set for this fire and stays excluded until the YAML parses again (next trigger event).
   This closes the "declared but never wired" gap from independent review: `recordValidationError` is now load-time, not fire-time. The orchestrator below assumes input trigger is already validated.

1. **Armed state** (`rt.triggersArmed.getState`): if `disarmed` → refuse `disarmed`; if `pending_dry_run` and not `isDryFire` → refuse `pending_dry_run`.
2. **Circuit** (`rt.triggerCircuit.isOpen`): if open → refuse `circuit_open`.
3. **Conditions** (`evaluateConditions`, Task 3.3): if not pass → refuse `condition_failed`. *(Conditions run early because a non-matching event is the common case and must be cheap; the shell condition cost is the author's choice, surfaced by `list --verbose`.)*
4. **Debounce** (`rt.triggerDebounce.observe`): if `{fire:false}` → refuse `debounce_active` (silent; exit 0).
5. **Dedup** (render `dedup_key` via Task 3.2, hash, compare against `rt.triggerFires.recentFor(name, cooldown_s*1000)`): if hit → refuse `dedup_hit`.
6. **Cooldown** (`rt.triggerFires.lastSpawnedFor`): if `now - last_spawned < cooldown_s*1000` → refuse `cooldown_active`.
7. **Per-trigger hourly cap** (`rt.triggerFires.fireCountFor(name, 3600_000) >= safety.hourly_cap`) → refuse `hourly_cap_exhausted`.
8. **Global hourly cap** (`rt.triggerFires.globalSpawnedSince(3600_000) >= budgetConfig.triggersGlobalHourlyCap`) → refuse `global_hourly_cap_exhausted`.
9. **Cause-chain / loop** (research §3.6): compose `causeChain' = [...parentChain, parentTriggerName?]` from `rt.casts.getCauseChain(parentCastId)` + `getTriggerName(parentCastId)`. Refuse if any: `causeChain'.length >= safety.loop.max_cause_chain_depth` → `cause_chain_depth_exceeded` (and `rt.triggerCircuit.recordDepthBreach`); `name ∈ causeChain' && refuse_if_self_in_chain` → `loop_self_in_chain`; any `refuse_if_any_in_chain` name ∈ chain → `loop_listed_in_chain`.
10. **Spawn** (only if all pass and not `isDryFire`): render `task_template`, call `spawnCast(rt, {mode, clones, task, scope, budget, force: false, triggerProvenance: {trigger_name: name, fired_at: now, parent_cast_id: parentCastId}, causeChain: causeChain', triggerName: name})`. If `runPreSpawnGate` inside `spawnCast` refuses (daily cap / charges / cooldown) → catch, refuse `budget_gate_failed`, `rt.triggerCircuit.recordBudgetRefusal(name)`, broadcast a `blocker` event. **No auto-downgrade.** On success: append `spawned` record with `cast_id` + `cost_estimate_usd`, `rt.triggerDebounce.clear(name)`.
   - If `isDryFire`: run steps 1-9 against a *synthetic* payload (sentinel values, research §3.5), then invoke `spawnCast`-equivalent dry preview through the gate WITHOUT spawning (reuse the existing `--dry-run` gate path), record the estimate, return `{decision:'spawned'}` as a dry signal (caller interprets as "dry-fire OK").

**Acceptance criteria (one test per refusal reason + the happy path + the budget-refusal circuit interaction):**
- `disarmed` trigger → refuse `disarmed`, no spawn, `fires.jsonl` records it.
- circuit open → refuse `circuit_open`.
- conditions fail → refuse `condition_failed`.
- debounce active → refuse `debounce_active`.
- dedup hit → refuse `dedup_hit`.
- cooldown active → refuse `cooldown_active`.
- hourly cap reached → refuse `hourly_cap_exhausted`.
- global cap reached → refuse `global_hourly_cap_exhausted`.
- cause_chain depth ≥ max → refuse `cause_chain_depth_exceeded` + circuit records a depth breach.
- self in chain → refuse `loop_self_in_chain`.
- listed name in chain → refuse `loop_listed_in_chain`.
- budget gate refuses (daily cap) → refuse `budget_gate_failed`, circuit records a budget refusal, `blocker` broadcast, **no downgrade**.
- all pass, armed → `spawnCast` called with `force: false` and full provenance; `spawned` record written; debounce cleared.
- **`force: false` is unconditional**: assert via a `spawnCast` spy that the trigger path NEVER passes `force: true`, regardless of input.
- dry-fire: runs eval, produces an estimate, does NOT call the real spawn.
- the guardrail ORDER matches the list (assert by instrumenting which check fires first when multiple would refuse — e.g. a disarmed + circuit-open trigger refuses `disarmed`, not `circuit_open`).

**Tests:**

- [ ] **Step 1: Write failing tests** — full refusal matrix with injected stores + fake clock + `spawnCast` spy + `ShellRunner` fake.

- [ ] **Step 2: Run — verify FAIL.**

- [ ] **Step 3: Implement `fire.ts`** with the exact guardrail sequence; `force: false` is a literal, not a variable.

- [ ] **Step 4: Run — verify PASS** + assert 100% branch coverage of `fire.ts` (every refusal branch).

- [ ] **Step 5: Commit**

```
feat(cli): trigger fire orchestrator — full guardrail sequence, force:false hard-coded, no bypass
```

---

### Chunk 3 complete when

- `pnpm gate` clean.
- `fire.ts` has 100% branch coverage (every refusal reason exercised).
- A `grep` of `packages/manta-cli/src/triggers/` finds **zero** occurrences of `force: true` and zero `--bypass`/`--no-gate` flags.
- The renderer injection-safety test and the condition raw-payload test both pass.

---

## Chunk 4 — CLI surface + `manta-hook` shim + `install-hooks`

Wires the evaluator to the user. Lands `manta trigger <subcommand>`, the `manta-hook` shim bin, and `manta install-hooks` (git + claude-code, with CI refusal). The `arm` command enforces the mandatory dry-fire. After this chunk a user can author, validate, arm (with dry-fire), and fire triggers end-to-end.

**Build dependency chain:** Task 4.1 (trigger command file) → Task 4.2 (register in bin/manta.ts) → Task 4.3 (manta-hook shim) → Task 4.4 (install-hooks).

~480 LOC. Chunk-completes when `pnpm gate` clean and a manual round-trip (add → arm → fire) works on a real repo.

### Task 4.1: `manta trigger` command implementations

**Files:**
- Create: `packages/manta-cli/src/commands/trigger.ts` — `runTrigger{Add,List,Show,Remove,Arm,Disarm,DisarmAll,Fire,FireForEvent,Circuit}Command`.
- Create: `packages/manta-cli/tests/commands/trigger.test.ts`
- Modify: `packages/manta-cli/src/index.ts` — re-export the runners.
- **Prerequisite (schema-first, CLAUDE.md HARD RULE):** Modify `packages/manta-cli/src/errors.ts:1` — widen `CliErrorKind` with `'trigger_validation_failed'`, `'trigger_not_found'`, `'trigger_already_exists'`, `'trigger_arm_no_dry_run'`, `'trigger_illegal_transition'`, `'install_hooks_ci_refused'` BEFORE any command code references them (same pattern as `'concurrent_cast_limit_reached'` at `errors.ts:13`).

**Why:** The user-facing surface (research §5). Each subcommand maps to the stores + evaluator. **`arm` is the security-critical one:** it enforces the dry-fire (research §3.5) — `--skip-dry-run` alone is insufficient; it additionally requires `MANTA_TRIGGER_ARM_SKIP_DRY_RUN=1` env (research §5.2 "one thing, two confirmations").

**Per-command behaviour (research §5.2):**
- **`add <file>`** (`--inline <yaml>`, `--name <override>`): `loadTriggerFromFile` → validate → reject if name collides (`trigger_already_exists`; require `remove` first) → reject if `event.source=claude-code-hook` and `.claude/settings.json` shim absent (suggest `install-hooks --claude-code`) → write `.manta/triggers/<name>.yaml` → state `disarmed` → render against a synthetic payload and print the rendered prompt for eyeballing. Exit non-zero with actionable message on validation fail (`trigger_validation_failed`).
- **`list`** (`--verbose`, `--json`, `--enabled-only`): columns `name | state | event | mode | clones | last_fire | hourly_remaining`; `--verbose` adds last-5-fires + 24h histogram + cost-to-date from `triggerFires.tail` + `dailySpend` reconciliation.
- **`show <name>`** (`--with-fires N`): YAML dump + `armed.json` entry + last debounce window + last N fires.
- **`remove <name>`** (`--force`): refuse if `armed` unless `--force`; delete YAML + bus state; append removal record.
- **`arm <name>`** (`--yes`, `--skip-dry-run`): `setPendingDryRun` → run `fireTrigger` with `isDryFire: true` against synthetic payload → print dry estimate → prompt `Arm trigger '<name>'? [y/N]` (or `--yes`) → on confirm `triggersArmed.arm(name, {dryRunEstimateUsd})`. `--skip-dry-run` requires `MANTA_TRIGGER_ARM_SKIP_DRY_RUN=1` else error `trigger_arm_no_dry_run`.
- **`disarm <name>`**: `triggersArmed.disarm`; idempotent.
- **`disarm-all`** (`--also-remove`): panic button — no confirmation, `triggersArmed.disarmAll()`, logs; `--also-remove` deletes YAMLs too.
- **`fire <name>`** (`--payload-json`, `--dry-run`): manual fire (source `manual`); `--dry-run` runs full eval minus spawn (`test` is its alias).
- **`fire-for-event`** (`--source --type --payload-json`): internal (called by `manta-hook`); iterates `loadAllTriggers` matching source+type, calls `fireTrigger` for each; **always exits 0** even on refusal (git hooks must not break the commit).
- **`circuit-status`** / **`circuit-reset`** (`--reason`): read/reset `triggerCircuit`.

**Acceptance criteria:**
- `add` of a valid file → YAML written, state `disarmed`, rendered preview printed.
- `add` of a colliding name → `trigger_already_exists`, no overwrite.
- `add` of a claude-code-hook trigger with no shim → error suggesting `install-hooks`.
- `arm` without dry-fire confirmation does NOT reach `armed` (stays `pending_dry_run` or rolls back to `disarmed`).
- `arm --skip-dry-run` without the env var → `trigger_arm_no_dry_run`.
- `arm --skip-dry-run` WITH `MANTA_TRIGGER_ARM_SKIP_DRY_RUN=1` + `--yes` → `armed`.
- `disarm-all` flips everything with no prompt.
- `fire-for-event` exits 0 on a refused trigger (assert exit code).
- `remove` of an armed trigger without `--force` → refused.
- `list --json` emits parseable JSON with the documented columns.

**Tests:**

- [ ] **Step 0 (schema-first): Widen `CliErrorKind`** with the six new kinds.

- [ ] **Step 1: Write failing tests** — drive each runner against injected stores/tmp repo; mock the interactive prompt; assert exit codes.

- [ ] **Step 2: Run — verify FAIL.**

- [ ] **Step 3: Implement `trigger.ts`.**

- [ ] **Step 4: Run — verify PASS.**

- [ ] **Step 5: Commit**

```
feat(cli): manta trigger add/list/show/remove/arm/disarm/disarm-all/fire/circuit commands
```

---

### Task 4.2: Register `trigger` command group in `bin/manta.ts`

**Files:**
- Modify: `packages/manta-cli/src/bin/manta.ts` — add imports near the existing command-runner import block (look for `runDaemonStatusCommand` import as the anchor); register the `trigger` command group AFTER the existing `program.command('daemon')` block (grep-anchor: search for `const daemonCmd = program.command('daemon')` — pre-7c-edit it was around line :413; line numbers WILL drift, anchor by string match) and BEFORE the trailing `program.parseAsync(process.argv)` call (grep-anchor at end of file, pre-7c around :838).
- Modify: `packages/manta-cli/tests/bin/` (or CLI integration test) — assert `manta trigger --help` lists the subcommands.

**Why:** Wire the runners into commander. Follows the exact `daemonCmd` pattern (grep-anchor: `const daemonCmd = program.command('daemon')` in `bin/manta.ts` — line drifts, don't hard-pin): `const triggerCmd = program.command('trigger'); triggerCmd.command('add <file>')…`. `fire-for-event` is registered but **omitted from help text** (internal; called by the shim).

**Acceptance criteria:**
- `manta trigger --help` lists `add/list/show/remove/arm/disarm/disarm-all/fire/test/circuit-status/circuit-reset` (not `fire-for-event`).
- Each subcommand routes to its runner via `runWithRuntime` (the existing wrapper).
- `manta trigger add ./x.yaml` reaches `runTriggerAddCommand`.

**Tests:**

- [ ] **Step 1: Write failing CLI integration test.**

- [ ] **Step 2: Run — verify FAIL.**

- [ ] **Step 3: Register the group** mirroring `daemonCmd`.

- [ ] **Step 4: Run — verify PASS** + `pnpm -r build`.

- [ ] **Step 5: Commit**

```
feat(cli): register manta trigger command group in bin/manta.ts
```

---

### Task 4.3: `manta-hook` shim bin

**Files:**
- Create: `packages/manta-cli/bin/manta-hook` (ESM script, < 60 LoC) — or `packages/manta-cli/src/bin/manta-hook.ts` compiled to the bin.
- Modify: `packages/manta-cli/package.json` — add `"manta-hook": "./bin/manta-hook"` (or compiled path) to the `bin` map alongside the existing `manta` entry.
- Create: `packages/manta-cli/tests/bin/manta-hook.test.ts`

**Why:** Research §4.3 — avoid teaching users robust shell glue in `.git/hooks/*` / `.claude/settings.json`. The shim reads env/argv, builds a payload JSON, and execs `manta trigger fire-for-event`. Single bin re-using the CLI argv parser (research §7 Q1 recommendation: single binary, ~20 LoC glue).

**Behaviour:**
- `manta-hook git <event-type> [--sha … --changed-files-json … --commit-message-subject …]` → builds payload, execs `manta trigger fire-for-event --source git --type <event-type> --payload-json '<json>'`.
- `manta-hook claude <hook-event>` → reads the Claude Code hook stdin/env (the harness passes tool input via stdin JSON per Claude Code hook contract), builds payload (`file_path`, `tool_input`, etc.), execs `fire-for-event --source claude-code-hook --type <hook-event>`.
- **Always exits 0** (a non-zero from the shim would break `git commit` / block a Claude tool call). Errors are logged to stderr, never propagated as non-zero.

**Acceptance criteria:**
- `manta-hook git post-commit --sha abc …` builds the expected payload and invokes `fire-for-event` (assert via a stubbed exec).
- `manta-hook claude PostToolUse` with a stdin JSON payload extracts `file_path` from `tool_input` into the payload.
- The shim exits 0 even when `fire-for-event` errors (assert exit code).
- Unknown source → logs to stderr, exits 0.

**Tests:**

- [ ] **Step 1: Write failing tests** with a stubbed child-exec.

- [ ] **Step 2: Run — verify FAIL.**

- [ ] **Step 3: Implement the shim** + add to `bin` map.

- [ ] **Step 4: Run — verify PASS** + `pnpm -r build` (confirm the bin is emitted/executable).

- [ ] **Step 5: Commit**

```
feat(cli): manta-hook shim bin — git/claude payload builder, always exit 0
```

---

### Task 4.4: `manta install-hooks` — git + claude-code, CI-refusal

**Files:**
- Create: `packages/manta-cli/src/commands/install-hooks.ts`
- Create: `packages/manta-cli/tests/commands/install-hooks.test.ts`
- Modify: `packages/manta-cli/src/bin/manta.ts` — register `install-hooks` near the `trigger` group.
- Modify: `packages/manta-cli/src/index.ts` — re-export `runInstallHooksCommand`.

**Why:** Research §4.3 + §3.0 T7. Writes `.git/hooks/<event>` shims (`exec manta-hook git <event> "$@"`) and patches `.claude/settings.json` (append a `PostToolUse` entry with `timeout: 1500`, preserving existing hooks). **CI refusal (T7):** default refuse to install when a CI env is detected; `--force-ci` opt-in.

**Behaviour:**
- `--git` (default if neither flag): wire `post-merge`, `post-commit`, `post-checkout`, `post-rewrite` with `# >>> manta-hook >>>` / `# <<< manta-hook <<<` comment markers (research §7 Q2 — append-with-markers, idempotent). Omit `pre-commit`/`pre-push` (research §1.3 — not casting territory).
- `--claude-code`: append a `PostToolUse` matcher `Edit|Write|Bash` entry to `.claude/settings.json`, preserving existing user hooks (parse → append → write; never overwrite).
- `--dry-run`: print the diff, write nothing.
- `--force-ci`: bypass CI refusal.
- `--uninstall`: remove the marked blocks / the appended Claude entry only (leave user content intact).
- **CI detection:** `process.env.CI === 'true' || GITHUB_ACTIONS || GITLAB_CI` (research §7 Q5). On detection without `--force-ci` → `install_hooks_ci_refused`.

**Acceptance criteria:**
- `install-hooks --git` writes the four hook files with comment markers; re-running is idempotent (no duplicate blocks).
- `install-hooks --git` preserves a pre-existing user `post-commit` body (appends below the marker).
- `install-hooks --claude-code` appends to `.claude/settings.json` without dropping existing hooks.
- `install-hooks --dry-run` writes nothing, prints a diff.
- `CI=true manta install-hooks` → `install_hooks_ci_refused`; `--force-ci` overrides.
- `install-hooks --uninstall` removes only the manta blocks.

**Tests:**

- [ ] **Step 1: Write failing tests** with a tmp git repo + a tmp `.claude/settings.json`.

- [ ] **Step 2: Run — verify FAIL.**

- [ ] **Step 3: Implement** with marker-based idempotent merge + CI detection.

- [ ] **Step 4: Register in bin + re-export + run — verify PASS** + `pnpm gate`.

- [ ] **Step 5: Commit**

```
feat(cli): manta install-hooks — git + claude-code marker-merge, CI-refusal, --uninstall
```

---

### Chunk 4 complete when

- `pnpm gate` clean.
- Manual round-trip on a fresh tmp repo: `manta install-hooks --git`, author a trigger YAML, `manta trigger add`, `manta trigger arm --yes` (dry-fire runs), `manta trigger fire --dry-run`, `manta trigger list --verbose`, `manta trigger disarm-all` — all succeed with expected on-disk state.
- `manta trigger arm` provably refuses to reach `armed` without a dry-fire.

---

## Chunk 5 — e2e safety tests + docs + INDEX/CHANGELOG

Proves the guardrails on the *full* pipeline (real `manta-hook` → `fire-for-event` → gate → refuse/spawn), ships user + architecture docs, and records the phase in INDEX/CHANGELOG. The e2e tests are the acceptance evidence that the highest-risk feature is safe.

**Build dependency chain:** Task 5.1 (e2e safety tests) → Task 5.2 (docs) → Task 5.3 (INDEX/CHANGELOG/bug-log).

~360 LOC tests + docs. Chunk-completes per the explicit "complete when" list.

### Task 5.1: e2e safety tests — the refusal pipeline end-to-end

**Files:**
- Create: `packages/manta-e2e/tests/triggers-safety.e2e.test.ts` (env-gated `MANTA_E2E=1`, mirrors the Phase 7a e2e pattern).
- Create: fixtures under `packages/manta-e2e/tests/fixtures/triggers/` — three valid trigger YAMLs (the §2.4 examples) + a loop-inducing pair.

**Why:** Research §9 Chunk E. Unit tests prove each guardrail in isolation; the e2e proves they hold when wired through the real shim + CLI + gate. Each scenario drives `manta-hook` (or `fire-for-event` directly) against a real tmp repo with a real (fake-clock-overridable) bus state.

**Scenarios (one test each):**
- **Loop refusal:** a cast tagged with `cause_chain: ['t']` parent-fires trigger `t` again → refused `loop_self_in_chain`; depth-3 chain → `cause_chain_depth_exceeded`.
- **Circuit breaker:** drive 3 distinct triggers to budget-refuse within the window → circuit opens → all triggers forced `disarmed` → a subsequent fire refuses `circuit_open` → `circuit-reset` re-enables.
- **Daily-cap refusal (no downgrade):** set daily spend near cap → trigger fire refuses `budget_gate_failed`, asserts NO mode-downgrade occurred, `blocker` broadcast present.
- **Dedup:** same `dedup_key` fired twice within cooldown → second refused `dedup_hit`.
- **Cooldown:** two spawns within `cooldown_s` → second refused `cooldown_active`.
- **Debounce:** burst of events within `debounce_ms` → only one proceeds.
- **Hourly caps:** per-trigger and global caps both enforced.
- **fire-for-event exit 0:** a refused fire exits 0 (git-hook safety).

**Acceptance criteria:**
- Each scenario passes under `MANTA_E2E=1`.
- The full suite leaves no orphan processes and no `.manta/state` writes outside the tmp repo.

**Tests:**

- [ ] **Step 1: Build fixtures** (the three §2.4 YAMLs + a self-referential loop pair).

- [ ] **Step 2: Write the e2e scenarios** (env-gated).

- [ ] **Step 3: Run** `MANTA_E2E=1 pnpm -F @manta/e2e test triggers-safety.e2e.test.ts` — verify PASS.

- [ ] **Step 4: Commit**

```
test(e2e): trigger safety pipeline — loop/circuit/daily-cap/dedup/cooldown/debounce/caps refusals
```

---

### Task 5.2: User + architecture docs

**Files:**
- Create: `docs/user/triggers.md` — getting started, the three examples, `arm` dry-fire flow, **panic button (`disarm-all`)** up top, the full command table.
- Create: `docs/internals/triggers.md` — guardrail rationale, the loop-detection-at-orchestrator-level argument, links to research.
- Modify: `docs/internals/claude-code-pitfalls.md` — add a section cross-referencing §3.6 (loop detection enforced at orchestrator/gate level, NOT skill text — a concrete application of pitfall §1).

**Why:** CLAUDE.md — every feature ships with user-facing docs + an architecture note in the same phase. The pitfalls cross-reference is explicit in research §9 Docs.

**Acceptance criteria:**
- `docs/user/triggers.md` documents every command + flag accurately and leads with `disarm-all`.
- `docs/internals/triggers.md` explains why triggers are synchronous-on-event (not daemon-polled) and why loop refusal lives at the gate, not in skill text.
- `claude-code-pitfalls.md` gains the cross-reference.

**Tests:**

- [ ] **Step 1: Write `docs/user/triggers.md`.**

- [ ] **Step 2: Write `docs/internals/triggers.md`.**

- [ ] **Step 3: Append the pitfalls cross-reference.**

- [ ] **Step 4: Run skill-validator integration test** (paranoia — confirm docs don't break doc-discovery).

- [ ] **Step 5: Commit**

```
docs: triggers user guide + internals architecture note + pitfalls cross-ref
```

---

### Task 5.3: INDEX.md + CHANGELOG.md + bug-log

**Files:**
- Modify: `docs/superpowers/plans/INDEX.md` — flip the `2026-05-28-phase-7c-auto-triggers.md` row from `TODO (not yet written)` to `**TODO**` (plan written) at write-time, then to `**Executed**` with chunk commits inline once Chunk 5 lands.
- Modify: `CHANGELOG.md` — add the Phase 7c entry.
- Modify: `docs/manta-bugs.md` — log any bug surfaced during implementation (per CLAUDE.md defer-nothing).

**Why:** INDEX.md is the source-of-truth map; CHANGELOG ships every phase.

**CHANGELOG entry:**

```markdown
## [0.x.0] - 2026-05-?? — Phase 7c Auto-cast Triggers (git/claude-code/manual, arm-with-dry-fire)

### Added
- `manta trigger add/list/show/remove/arm/disarm/disarm-all/fire/test/circuit-status/circuit-reset`
- `manta install-hooks [--git] [--claude-code] [--dry-run] [--force-ci] [--uninstall]`
- `manta-hook` shim bin (git + claude-code payload builder)
- `TriggerDefSchema` strict trigger DSL in `@manta/bus` (mandatory forbidden_paths, budget-cap refine)
- `CastManifest.metadata.trigger` + `metadata.cause_chain` provenance (frozen contract for Phase 7b share)
- Four bus stores: `TriggersArmedStore`, `TriggerFiresLog`, `TriggerDebounceStore`, `TriggerCircuitStore`
- `spawnCast` reusable gate-then-spawn seam (shared by manual + trigger paths)
- `budget.json` `triggers.global_hourly_cap` (default 6)

### Safety
- Default-disarmed posture; `arm` requires a mandatory dry-fire (+ env var for `--skip-dry-run`)
- Every trigger-fired cast passes `runPreSpawnGate` with `force: false` hard-coded — no bypass flag
- Loop detection via cause-chain (refuse depth ≥ 3 or self/listed trigger in chain)
- Global circuit breaker (budget-refusal burst / depth-breach repeat) + `disarm-all` panic button
- `install-hooks` refuses CI environments by default (`--force-ci` opt-in)

### Deferred to Phase 8+
- Filesystem watcher + test-runner watch sources (long-lived daemon)
- CI webhook ingress (Manta Cloud)
- `PreToolUse`-source triggers (latency budget)
- MCP `manta.trigger_fire` (recursive cast — unlocks with phantom-lance)
- `manta trigger lint` (the proper fix for the user-authored DSL risk)
- `fires.jsonl` rotation
```

- [ ] **Step 1: Apply INDEX.md status.**
- [ ] **Step 2: Apply CHANGELOG entry.**
- [ ] **Step 3: Log any surfaced bug in `docs/manta-bugs.md`.**
- [ ] **Step 4: Run skill-validator integration test** (INDEX parsable).
- [ ] **Step 5: Commit**

```
chore: Phase 7c complete — INDEX + CHANGELOG + bug-log
```

---

### Chunk 5 complete when

- `pnpm gate` clean.
- `MANTA_E2E=1 pnpm -F @manta/e2e test triggers-safety.e2e.test.ts` green.
- `docs/user/triggers.md` + `docs/internals/triggers.md` ship; `claude-code-pitfalls.md` cross-referenced.
- INDEX.md Phase 7c row `**Executed**` with chunk commits inline.
- CHANGELOG has the Phase 7c entry.
- Post-mortem written for the implementing cast in `docs/post-mortems/`.

---

## Risk surface

> This section is mandatory and headlines the **one residual risk Phase 7c does not solve**: the trigger config DSL is **user-authored**.

### R0 (HEADLINE — unsolved by design): User-authored trigger DSL

A malicious or merely careless trigger YAML defeats every other guardrail at the source. Examples:

- `action.scope.allowed_paths: ['/']` — worktree creation outside the repo.
- `action.mode: phantom-lance` — recursive-cast mode (if the Aghs lock were ever lifted).
- `action.clones: 8` + a tight `cooldown_s` — burst spend.
- a `conditions: shell` `cmd` that does something hostile under the user's account.

**What Phase 7c does to contain it (defence-in-depth, NOT a full fix):**

| Layer | Mechanism | Where |
|---|---|---|
| Schema | `forbidden_paths` MUST include `.manta/state` + `secrets/` (`.refine`); `enabled: false` literal; `per_cast_usd <= per_fire_budget_usd` refine; `mode` restricted to the 10-mode enum; `clones <= 8` | Task 1.3 `TriggerDefSchema` |
| Aghs lock | `phantom-lance` / `council` / `decoy` remain Aghs-locked; a trigger naming them still cannot spawn them until Phase 8 unlock | existing mode-gate (reused) |
| Explicit add | `.manta/triggers/*.yaml` is NEVER auto-loaded on `git pull`; `add` takes an explicit path | Task 3.1 loader, research §3.9 |
| Explicit arm | `add` never arms; `arm` requires a dry-fire + interactive confirm (or double env-gated `--skip-dry-run`) | Task 4.1 `arm` |
| Budget gate | every fire passes `runPreSpawnGate` with `force: false`; per-trigger hourly cap + global cap + daily cap | Task 3.4 fire orchestrator |
| Loop gate | cause-chain refusal at the orchestrator, not skill text | Task 3.4 |
| Circuit | global breaker + `disarm-all` panic | Task 1.8 + Task 4.1 |
| Template safety | substitutions render ONLY into `task_template`/`dedup_key`, NEVER into `conditions: shell` cmds (T5) | Task 3.2 renderer, Task 3.3 conditions |

**What is explicitly NOT solved (the residual):** a user who *authors* a hostile YAML, runs `manta trigger add` on it, and `manta trigger arm`s it with confirmation. That is social engineering + author intent — not preventable at runtime. The `shell` condition in particular runs author-supplied shell under the user account; it is sandboxed only by OS permissions. **The proper fix is a Phase 8 `manta trigger lint` that scores scope/budget/shell smells and PR-blocks high-risk triggers** (research §8). Phase 7c ships without it and says so loudly in `docs/user/triggers.md`.

### Other risks (from research §3.0 threat model, all mitigated in-scope)

| # | Failure | Mitigation tier | Where |
|---|---|---|---|
| T1 | Infinite loop (cast→trigger→cast) | HARD — cause-chain + circuit | Task 3.4, 1.8 |
| T2 | Burst (50 commits → 50 casts) | HARD — hourly cap + cooldown + debounce | Task 1.6, 1.7, 3.4 |
| T3 | Mis-scoped trigger | HARD — schema validation + Aghs + mandatory forbidden_paths | Task 1.3 |
| T4 | Stale trigger fires | SOFT — cooldown + per-trigger cap absorb | Task 3.4 |
| T5 | Template injection into shell | HARD — substitutions never reach condition cmds | Task 3.2, 3.3 |
| T6 | Accidental `--yes` arm | SOFT — dry-run preserved + audited; double env-gate on `--skip-dry-run` | Task 4.1 |
| T7 | Hook fires in CI | HARD — `install-hooks` CI-refusal default | Task 4.4 |

### Implementation risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `spawnCast` extraction (Task 2.2) regresses manual cast | Low | High | Pure refactor; the entire existing cast suite is the regression gate, run before commit. Re-grep `cast.ts:236`/`:275`/`:420`/`:427` before editing (lines drift; Phase 7a already moved them). |
| Guardrail ORDER bug (a check runs out of order, leaking a spawn) | Medium | High | The fire orchestrator's order is asserted by a dedicated test (Task 3.4 acceptance: "guardrail ORDER matches the list"); 100% branch coverage required on `fire.ts`. |
| `force: true` sneaks into the trigger path | Low | Catastrophic | `force: false` is a literal in `fireTrigger`, not a variable; Chunk 3 completion requires a `grep` proving zero `force: true` / `--bypass` in `src/triggers/`. |
| git-hook latency breaks `git commit` trust | Medium | Medium | `fire-for-event` spawns the cast detached and returns; the no-fire path exits in a few hundred ms. Research §4.2 — ship a warning if total fire latency > 1500ms; measure in e2e. |
| Skill-text enforcement creep | Medium | High | CLAUDE.md HARD RULE: NO enforcement in skill/priming. Every guardrail here is a store method or an orchestrator branch (harness/code level), never an instruction to a clone. |

---

## Cross-phase notes

**Frozen contract for Phase 7b (clone-A `manta share`):** `CastTriggerProvenanceSchema` + `CastMetadataSchema` (Task 1.1) are the trigger-provenance contract. A's share-bundle `castOrigin` block must carry `metadata.trigger.trigger_name`, `metadata.trigger.parent_cast_id`, and the full `metadata.cause_chain` **verbatim** — A must NOT strip `cause_chain` (audit-trail invariant; a shared cast's provenance is part of its forensic record). Field names are frozen; any rename after this plan ships is a breaking change to the bundle contract. (Broadcast `dependency/phase-7c-triggered_by-contract`, `cast-1780019284984`.)

**Reuse from Phase 7a:** `Runtime` shape (`runtime.ts:41`), `runPreSpawnGate` (`pre-spawn-gate.ts:34`), `ModeSchema` (the 10-mode enum), `loadBudgetConfig` (`budget-config.ts:60`), `yaml` dep (`package.json:39`), atomic-fs primitives. No Phase 7a contract is mutated by 7c (additive only).

**Phase 8 follow-ups (out of scope, listed for the next planner):** filesystem/test-watch sources via a `manta watch start` daemon shelling out to the same `fire-for-event` evaluator; CI webhook ingress (Manta Cloud); `PreToolUse`-source triggers once cast spawn caches under 1s; MCP `manta.trigger_fire` post-phantom-lance; `manta trigger lint`; `fires.jsonl` rotation; trigger templates in the Library.

---

## Verification

**Pre-merge gate (run after every chunk, verified by self-run per CLAUDE.md — never on a subagent's word):**

```
pnpm gate          # = pnpm typecheck && pnpm lint && pnpm test (fail-fast)
```

**Per-chunk verification:**

| Chunk | Verification |
|---|---|
| 1 | `pnpm gate` clean; every new schema `.strict()`; every store uses existing atomic-fs (no new mutex); `@manta/bus` index re-exports all new symbols; `CastManifestSchema` accepts metadata AND every Phase 0-7a cast test still passes (backward-compat). |
| 2 | `pnpm gate` clean; **zero behavioural regression** in `manta cast` (existing cast suite green, no edits except additions); `spawnCast` is the single gate-then-spawn entry. |
| 3 | `pnpm gate` clean; `fire.ts` 100% branch coverage; `grep -rn 'force: true\|--bypass\|--no-gate' packages/manta-cli/src/triggers/` returns nothing; renderer injection-safety test + condition raw-payload test pass; guardrail-order test passes. |
| 4 | `pnpm gate` clean; manual round-trip (install-hooks → add → arm-with-dry-fire → fire --dry-run → list --verbose → disarm-all) on a tmp repo; `arm` provably cannot reach `armed` without a dry-fire. |
| 5 | `pnpm gate` clean; `MANTA_E2E=1 pnpm -F @manta/e2e test triggers-safety.e2e.test.ts` green (loop/circuit/daily-cap/dedup/cooldown/debounce/caps refusals all proven on the full pipeline); docs ship; INDEX/CHANGELOG updated; post-mortem written. |

**Safety-invariant verification (the acceptance evidence for "highest-risk feature is safe"):**

1. **Default-disarmed:** a freshly `add`ed trigger has bus state `disarmed`; `fire-for-event` against it records `decision: 'refused', reason: 'disarmed'` and does NOT spawn. (e2e Task 5.1 + unit Task 3.4.)
2. **Arm requires dry-fire:** `arm` without a successful dry-fire + confirm never transitions to `armed`. (Task 1.5 illegal-transition test + Task 4.1.)
3. **No budget bypass:** there is no flag and no code path that spawns a trigger cast with `force: true` or that skips `runPreSpawnGate`. (`grep` gate + `spawnCast`-spy test.)
4. **Loop-safe:** a self-referential or depth-exceeding cause-chain is refused before spawn, at the gate level (not skill text). (e2e loop scenario.)
5. **Panic works:** `disarm-all` flips every trigger to `disarmed` with no confirmation and never throws. (Task 1.5 + Task 4.1.)
6. **CI-safe:** `install-hooks` refuses CI by default. (Task 4.4.)
7. **Injection-safe:** a payload containing shell metacharacters renders as a literal string and is never passed to a condition `cmd`. (Task 3.2 + 3.3.)

**Whole-phase done when:** all five chunks' "complete when" lists satisfied, the seven safety invariants verified, `pnpm gate` + the e2e suite green, docs shipped, INDEX/CHANGELOG/bug-log updated, and the post-mortem written. The frozen `triggered_by` contract is confirmed consumed (not contradicted) by Phase 7b before either merges.
