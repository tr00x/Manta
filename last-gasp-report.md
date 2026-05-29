# Last-gasp report — clone-C, cast-1780023638705 (forking-realities)

## Summary

Implemented **Phase 7c Chunk 1 in full** (Tasks 1.1–1.9): every Zod schema and bus-side
state store the auto-cast-trigger feature needs, landed schema-first per the plan, each via
the TDD Step 1-7 pattern with its own atomic commit. `CastManifestSchema` now carries optional
trigger provenance (`metadata.trigger` + `metadata.cause_chain`), `BudgetConfigSchema` carries
`triggers.global_hourly_cap` (default 6), `TriggerDefSchema` parses the strict trigger DSL with
mandatory `forbidden_paths` and a parse-time budget-cap refine, the four trigger state stores
(armed / fires / debounce / circuit) read/write atomically through the existing `atomicMutateJson`
/ `appendJsonLine` primitives, and `CastsStore` gained `getCauseChain`/`getTriggerName` accessors
with metadata round-tripping through `create`. **STOPPED at Chunk 1** — Chunk 2+ untouched, per contract.

`pnpm gate`: **typecheck clean, lint clean, 1324/1325 tests pass.** The single red test
(`heartbeat-hook.test.ts > touch script updates last_heartbeat_at`) is the already-documented,
pre-existing, environment-scoped **Bug #53** (fresh-worktree `pnpm install` + `proper-lockfile`
resolution in the macOS tmpdir symlink) — it lives in the spawner subsystem, is byte-identical to
base, and is outside Chunk 1's surface. Confirmation appended to `docs/manta-bugs.md` #53.

## Commits (branch manta/cast-1780023638705/C, oldest→newest)

| Task | SHA | Subject |
|---|---|---|
| 1.1 | `8b3f601` | feat(bus): CastManifest trigger provenance metadata (triggered_by + cause_chain) |
| 1.2 | `c25cc81` | feat(bus,cli): budget config triggers.global_hourly_cap (default 6) |
| 1.3 | `727a4e6` | feat(bus): TriggerDefSchema — strict trigger DSL with mandatory forbidden_paths + budget cap refine |
| 1.4 | `857abec` | feat(bus): resolve .manta/state/triggers/* paths with name traversal guard |
| 1.5 | `a5eed1b` | feat(bus): TriggersArmedStore — disarmed/pending_dry_run/armed state machine + panic disarm-all |
| 1.6 | `05d8a6f` | feat(bus): TriggerFiresLog — append-only audit + sliding-window cap/cooldown counters |
| 1.7 | `b4ee393` | feat(bus): TriggerDebounceStore — collapse event bursts within debounce_ms |
| 1.8 | `f978faa` | feat(bus): TriggerCircuitStore — global breaker on budget-refusal burst + depth-breach repeat |
| 1.9 | `f086b20` | feat(bus): CastsStore.getCauseChain + getTriggerName for loop-detection chain composition (+ Bug #53 note) |

## Tests added (all green)

- `packages/manta-bus/tests/cast-manifest-trigger-metadata.test.ts` — **15 tests** (provenance / metadata / manifest / create-input).
- `packages/manta-bus/tests/state/charge-schemas.test.ts` — **+5 tests** (triggers.global_hourly_cap default/override/positive/strict) + updated empty-config assertion.
- `packages/manta-cli/tests/config/budget-config.test.ts` — **+1 test** (`triggersGlobalHourlyCap` file override) + `triggersGlobalHourlyCap` added to all-required-fields list + default-6 assertion in the no-file test.
- `packages/manta-bus/tests/trigger-schema.test.ts` — **16 tests** (3 worked examples + 13 refusal paths).
- `packages/manta-bus/tests/state/paths.test.ts` — **+3 tests** (trigger subtree paths + debounce-name traversal guard).
- `packages/manta-bus/tests/state/triggers-armed.test.ts` — **9 tests** (state machine, illegal_transition, panic disarm-all, validation-error disarm, 10-way concurrency).
- `packages/manta-bus/tests/state/triggers-fires.test.ts` — **9 tests** (cross-field invariants + all sliding-window queries).
- `packages/manta-bus/tests/state/triggers-debounce.test.ts` — **4 tests** (zero / within-window / expired / clear).
- `packages/manta-bus/tests/state/triggers-circuit.test.ts` — **7 tests** (both trip rules, distinct-name, pruning, reset).
- `packages/manta-bus/tests/state/casts.test.ts` — **+5 tests** (metadata round-trip + getCauseChain/getTriggerName).

## Gate output (final `pnpm gate` run)

```
pnpm typecheck → tsc -b: clean
pnpm lint      → eslint: clean
pnpm test      → Test Files 1 failed | 156 passed (157)
                 Tests       1 failed | 1324 passed (1325)
```
The lone failure is Bug #53 (pre-existing, env-scoped, spawner subsystem, NOT Chunk 1).

## Decisions worth flagging to the main

1. **`triggers.global_hourly_cap` via `.extend()`, not inside `.partial()`** — the plan snippet placed
   it inside the `.object({...})` block, but `.partial()` wraps each field in `ZodOptional` which
   short-circuits the inner `ZodDefault`, so the default never fires. Moved it to `.extend()` after
   `.partial().strict()` so the acceptance criterion (`parse({}).triggers.global_hourly_cap === 6`)
   holds. **Side effect:** `BudgetConfigSchema.parse({})` now returns `{ triggers: { global_hourly_cap: 6 } }`
   instead of `{}`; the one existing test asserting `{}` was updated (sanctioned by the plan's "modify
   budget schema test"). Downstream readers use specific keys, so the injected `triggers` is harmless.
2. **Trigger names are min-2-char kebab everywhere** (`TriggerNameSchema` `/^[a-z0-9-]{2,48}$/`).
   `z.record(TriggerNameSchema, …)` validates keys, so armed/debounce/circuit reject single-char names;
   the path-traversal guard in `triggersDebounce` reuses the same regex.
3. **`create()` metadata round-trip** required a 1-line `defaultFactory` change (conditionally spread
   `input.metadata`) — the plan said "no algorithmic change, just verify it persists," but the factory
   hard-coded the field list and dropped metadata. Conditional spread keeps manual casts metadata-key-free
   (backward-compatible).

## Pending / not done (by design)

- **Chunk 2+** (spawnCast seam, runtime wiring, CLI `trigger` commands, fire orchestrator, install-hooks,
  manta-hook shim) — **NOT started**. Contract was Chunk 1 only.
- **Bug #53** — still Open, out of scope; fix candidates listed in `docs/manta-bugs.md`.
- Sibling clone **D** ran the same contract independently (forking-realities). The main should consult
  `docs/merge-reviews/cast-1780023638705.md` (if generated) and follow its verdict — do not blind-merge both.
