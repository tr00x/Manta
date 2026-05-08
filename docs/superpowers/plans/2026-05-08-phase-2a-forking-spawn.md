# Phase 2a — `forking-realities` Spawn Surface + Cast Manifest Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Production-grade spawn surface for `forking-realities` casts. After this plan ships, `manta cast forking-realities --clones 3 --tasks <plan.yaml>` produces 3 worktrees with **distinct per-clone tasks/scopes/approach hints**, every clone's snapshot/contract/registry record carries the **cast_mode**, and a new **cast manifest** (`.manta/state/casts/<castId>.json`) records the cast's policy + roster so Phase 2b (bus isolation) and Phase 2c (merge-review) can consume it without re-deriving.

**Architecture:** Two chunks. Chunk 1 lands the cast manifest as a new `@manta/bus` state module (schema, store, paths, errors) plus the `cast_mode` registry-metadata bump, wired into the spawner so every cast — including unchanged `recon-swarm` casts — writes one manifest atomically before any clone runs. Chunk 2 lands the CLI/spawner surface for per-clone task fan-out (`RunCastOptions.cloneAssignments`), the `--tasks <path>` flag (YAML/JSON), the cumulative-budget switch from `N×cap` to `Σ(per-clone caps)`, the `{APPROACH_HINT_BLOCK}` priming-template slot, and the `forking-realities` allowlist edit on `SUPPORTED_MODES`.

**Tech Stack:** TypeScript 5.x strict, Node 20+, `zod`, `vitest`, the existing `@manta/bus` `atomicMutateJson`/`atomicReadJson`/`Clock` primitives. One new runtime dep: `yaml` (^2.6) for `--tasks` parsing — already widely used, MIT-licensed, no transitive bloat. No changes to `@manta/snapshot` schema — `Scope`/`approachHint`/`siblingClones` are already per-clone-capable; only the spawn surface needs to fan out.

---

## Why two chunks (and not one, and not four)

The spawn surface and the cast manifest are tightly coupled — the spawner writes the manifest, the spawner reads cloneAssignments out of CLI options to populate it, and any reviewer checking "did Chunk 2 wire the manifest right" needs Chunk 1 already on disk. But the manifest's schema + store + tests are large enough (≈700 lines of new code/tests) that bundling them with the CLI fan-out (~600 lines) crosses the ≤1000-line per-chunk target from CLAUDE.md plan discipline. So:

- **Chunk 1** (manifest infrastructure + `cast_mode` registry metadata) — pure additive, zero regressions, ships green standalone with its own test sweep. The spawner gets one new line that calls `casts.create(...)` after `registry.register` (idempotent across all clones of the same cast — every clone calls it; only the first writes). Existing `recon-swarm` casts get a manifest with `policy.peer_messaging = 'allowed'` and the same single-task overlay every clone receives — i.e. backward-compatible by construction. `metadata.cast_mode` is added to the registry record in this chunk so Phase 2b's filter join key is in place the moment the manifest is.
- **Chunk 2** (per-clone fan-out, CLI surface, mode allowlist, priming `{APPROACH_HINT_BLOCK}`, asymmetric budget) — depends on Chunk 1's manifest because `cloneAssignments` lands in the manifest's `clones[].assignment` field. Cannot be reordered. Chunk 2 also flips Chunk 1's stub `castPolicy = { peer_messaging: 'allowed', auto_merge_threshold: null }` to the mode-aware value (`'denied'` for forking-realities) at the cast.ts call site — single write to the manifest with the right policy, no double-write conflict.

Splitting further (4 chunks) would over-fragment: the per-clone overlay edits in `cast.ts` and the `--tasks` CLI parsing edits in `bin/manta.ts` are mechanically intertwined (the CLI parser is the only producer of `cloneAssignments`), and reviewing them apart from each other invites cross-plan field-name drift — the exact failure mode CLAUDE.md flags as Phase 0's #1 blocker class.

---

## Scope

In-scope (Phase 2a):
- New `@manta/bus` module `state/casts.ts` with `CastsStore` (atomic JSON, mutex-aware, follows the same shape as `state/contracts.ts`).
- New shared module `packages/manta-bus/src/state/canonicalize.ts` extracted from the existing `state/contracts.ts:24-35` private helper. Single export `canonicalize(v: unknown): unknown`. `state/contracts.ts` is updated to import from there (one-line refactor); `state/casts.ts` uses the same helper for `sameClones` equality. Two callers justify the extraction; inlining a recursive helper invites drift.
- New schema entries in `packages/manta-bus/src/schema.ts`: `CastManifestSchema`, `CastPolicySchema`, `CloneAssignmentSchema`, `CreateCastInputSchema`.
- New `BusPaths.castsDir` + `BusPaths.castFile(castId)` (see `state/paths.ts`).
- One new `BusContext` field, `casts: CastsStore`, in `packages/manta-bus/src/tools/index.ts:15-24` (the canonical interface site). `SubsetContext<K> = Pick<BusContext, K>` at line 26 picks up the new field automatically — no separate edit needed there. The construction site at `packages/manta-bus/src/server.ts:80-99` instantiates `new CastsStore(paths, clock)` and adds `casts` to the `context` literal (parallel to `registry`/`locks`/etc.). `src/index.ts:22` already re-exports `BusContext`/`SubsetContext` types; the new `CastsStore` is added to the value re-exports right next to `Registry`/`ContractsStore`.
- `manta-cli/src/spawner/clone-spawner.ts:80-93` extension — `register` call adds `cast_mode` to `metadata` (so Phase 2b's filter has its join key from day 1); the spawner also calls `casts.create(...)` for every clone of every cast (idempotent: re-creating an existing manifest with the same content is a no-op, anything else is `BusConflictError`). Idempotent-every-clone (rather than first-clone-special) avoids a fragile "did clone-A spawn before clone-B?" branch and survives a clone-A spawn failure.
- `manta-cli/src/commands/cast.ts:14` — allow `forking-realities` in `SUPPORTED_MODES`. Allow `recon-swarm` to coexist; no per-mode capability table yet (deferred to Phase 4 when more modes ship).
- `manta-cli/src/commands/cast.ts:27-46` — `RunCastOptions.cloneAssignments?: Record<CloneId, CloneAssignment>` typed pass-through.
- `manta-cli/src/commands/cast.ts:79-101` — cumulative-budget gate switches from `cloneCount * budgetUsdPerClone` to `Σ effectiveBudgetPerClone` so per-clone overrides are correctly summed.
- `manta-cli/src/commands/cast.ts:130-181` — spawn loop overlays per-clone `task` / `scope` / `approachHint` / `budgetUsd` / `deadlineMs` from `cloneAssignments` onto cast-level defaults.
- `manta-cli/src/spawner/priming.ts:3-22` — new `{APPROACH_HINT_BLOCK}` placeholder, expanded to `\nApproach hint: <value>\n` when `taskContract.approachHint != null && length > 0`, otherwise the placeholder is **removed entirely** (substituted with the empty string — no leftover "Approach hint: " label, no orphan blank line).
- `manta-cli/src/bin/manta.ts:45-117` — new `--tasks <file>` flag (YAML or JSON; auto-detect by extension); when present, replaces `--task` as the source of per-clone assignments. Mutually exclusive with `--task`; CLI rejects both at once.
- New `manta-cli/src/spawner/tasks-file.ts` — pure parser (input: file path or string, output: `Record<CloneId, CloneAssignment>` or a `CliError`).
- One unit test pinning the snapshot↔bus `approach_hint` nullable-vs-optional translation drift flagged by clone-A research §2.3 point 2 (no production change; the existing translation at `cast.ts:310-313` is correct, but the regression guard belongs in the same chunk that introduces real `approachHint` traffic).

Out of scope (deferred to other Phase 2 sub-plans):
- Bus isolation / sibling-message filter — Phase 2b.
- Merge-review / orchestrator finalisation hook — Phase 2c.
- Tier 3-4 observability commands (`tail`/`replay`/`audit`/`inspect`) — Phase 2d.
- Cast-policy enforcement (the manifest *records* policy in 2a; *acting* on it is 2b/2c work).
- Per-mode capability tables — deferred to Phase 4.
- Daemon-mode reads of the manifest — Phase 5.

---

## Spec & research alignment

Source-of-truth design: `docs/superpowers/specs/2026-05-06-manta-pattern-design.md`.

| Spec anchor | Demand | This plan's response |
|---|---|---|
| Sec 2 #2 | `forking-realities` is a Phase 2 mode | Allowlisted on `SUPPORTED_MODES` (Chunk 2 Task 2.4). |
| Sec 4 | "Worktree isolation" | Already correct per Phase 0d; verified by clone-A research §3, no edit needed. Documented as a non-change. |
| Sec 5.1 | Per-clone task contract with scope, approach, deadline | `RunCastOptions.cloneAssignments` carries them; per-clone overlay applies them at spawn time (Chunk 2 Task 2.5). |
| Sec 7 | Best-of-N flow needs cast-level state to know "all clones in cast X are DEAD" | Cast manifest gives Phase 2c a single document to query (Chunk 1 Task 1.2 schema, 1.5 store). |
| Sec 11 | Tier 3-4 commands need cast-scoped views | Cast manifest gives Phase 2d a clones-of-cast roster without joining `Registry.list()` against partial state (Chunk 1 Task 1.5). |
| Sec 14 | Production quality | TDD per task, no `// TODO` markers, ≥80% coverage on new code, atomic commits. |

Research deliverables consulted (in `docs/research/`):
- `phase-2-codepath-map.md` — clone-A — §1 spawn path + §2 snapshot path + §2.3 cast manifest sketch + §7 cross-cut summary table.
- `phase-2-best-of-n-patterns.md` — clone-B — referenced for `policy.auto_merge_threshold` schema field default; behaviour lives in Phase 2c.
- `phase-2-bus-isolation.md` — clone-C — referenced for `metadata.cast_mode` motivation (filter join key, §4.3) + `policy.peer_messaging` enum-of-strings (§4.4 forward-compatible cut). Filter implementation itself is 2b.

---

## Quality bar (CLAUDE.md / spec Sec 14)

- Test coverage ≥ 80 % statements/branches on every new file (`packages/manta-bus/src/state/casts.ts`, `packages/manta-cli/src/spawner/tasks-file.ts`, plus the new schema entries' parser exercises).
- TDD per task: failing test → run → minimal impl → re-run → commit.
- No `// TODO`, `// FIXME`, `it.skip`, `test.skip` in merged code.
- Atomic conventional commits with a `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` line.
- Ships with: short `README.md` update for `@manta/bus` listing the new state module, an `ARCHITECTURE.md` paragraph for the cast manifest, an updated `docs/user/recon-swarm.md` (recon-swarm casts now produce a manifest — operator FAQ).
- No lint warnings — fix or `// Reason:` suppress with explicit justification.
- Plan reviewer subagent must approve each chunk before it executes (CLAUDE.md plan-discipline §"reviewer-per-chunk loop").

---

## Reference docs

- Source-of-truth design: `docs/superpowers/specs/2026-05-06-manta-pattern-design.md` — Sec 2 (mode catalog), Sec 4 (worktree isolation), Sec 5.1 (task contract), Sec 7 (post-mortem flow), Sec 14 (production quality).
- Predecessor plans: `docs/superpowers/plans/2026-05-06-phase-0b-bus.md` (`@manta/bus` state-module pattern this plan reuses), `2026-05-06-phase-0d-cli.md` (`@manta/cli` spawn surface this plan extends), `2026-05-07-phase-1-recon-swarm-lockdown.md` (`metadata.cast_id` precedent).
- Phase 2 research deliverables: `docs/research/phase-2-codepath-map.md` (clone-A), `phase-2-best-of-n-patterns.md` (clone-B), `phase-2-bus-isolation.md` (clone-C).
- Project rules: `CLAUDE.md` — Quality bar (PROD only), Plan-writing discipline, Skill/priming/enforcement HARD RULES, Git rules.
- Pitfalls memo: `docs/internals/claude-code-pitfalls.md` — read before any change to skill text or priming preamble.

---

## Chunks

1. **Chunk 1 — Cast manifest infrastructure + `cast_mode` registry metadata.** Shared `state/canonicalize.ts` extraction; new `state/casts.ts` (`CastsStore`); schema entries; `BusPaths` extension; `BusContext.casts`; README/ARCHITECTURE notes. Spawner writes the manifest idempotently on every clone (first wins) and tags the registry metadata with `cast_mode`. Recon-swarm regression-guarded: existing tests stay green; new tests pin manifest creation + idempotency + 3 conflict branches (mode/roster/policy).
2. **Chunk 2 — Per-clone fan-out + CLI surface.** `RunCastOptions.cloneAssignments`, `--tasks <file>` flag, asymmetric cumulative-budget gate, `{APPROACH_HINT_BLOCK}` priming-template slot, `forking-realities` allowlisted on `SUPPORTED_MODES`. The new `tasks-file.ts` parses YAML/JSON and validates against `CloneAssignmentSchema`. Chunk 2 replaces Chunk 1's stub `castPolicy = { peer_messaging: 'allowed', ... }` with mode-aware computation at the cast.ts call site (single manifest write per cast — no double-write).

After both chunks pass reviewer-per-chunk, an end-to-end smoke test (with the existing `fakeCloneRunner`) spawns 2 forking-realities clones with distinct tasks/scopes, asserts each clone reads its own contract, asserts the cast manifest exists with both clones in `clones[]`, asserts each clone's `Registry.metadata.cast_mode === 'forking-realities'`. The smoke test lives in `packages/manta-cli/tests/integration/forking-spawn.test.ts` and is part of Chunk 2's last task.

---

## Chunk 1: Cast manifest infrastructure

**Goal of this chunk:** A reviewable, atomic, on-disk record of every cast — its mode, its roster, its policy, its creation timestamp — that downstream phases (2b, 2c, 2d) can read with zero coupling to clone state. After Chunk 1, every cast (recon-swarm and forking-realities alike) leaves behind one manifest file at `.manta/state/casts/<castId>.json`. Existing tests stay green; new tests pin the new behaviour.

**Files (new):**
- Create: `packages/manta-bus/src/state/canonicalize.ts` — extracted helper (recursive key-sort canonicalization), one default export `canonicalize(v: unknown): unknown`.
- Create: `packages/manta-bus/src/state/casts.ts` — `CastsStore` class.
- Create: `packages/manta-bus/tests/state/casts.test.ts` — schema + store unit tests.
- Create: `packages/manta-bus/tests/state/canonicalize.test.ts` — small unit sweep so the extracted helper is independently covered (5 cases — primitives, arrays, key-sorted objects, nested mixes, identity).
- Create: `packages/manta-bus/tests/integration/cast-manifest.test.ts` — cross-restart durability + concurrency under mutex.

**Files (modified):**
- Modify: `packages/manta-bus/src/state/contracts.ts:24-35` — delete the private `canonicalize` helper, add `import { canonicalize } from './canonicalize';` at the top. Existing tests at `packages/manta-bus/tests/state/contracts.test.ts` must stay green (no behavioural change — same algorithm, different module).
- Modify: `packages/manta-bus/src/schema.ts` — add `CastIdSchema`, `CastPolicySchema`, `CloneAssignmentSchema`, `CastManifestSchema`, `CreateCastInputSchema` plus the corresponding `export type` lines.
- Modify: `packages/manta-bus/src/state/paths.ts` — add `castsDir` + `castFile(castId)` to `BusPaths`; tests in `packages/manta-bus/tests/state/paths.test.ts` (existing) gain one case per the rule below.
- Modify: `packages/manta-bus/src/index.ts:1-22` — add `export { CastsStore } from './state/casts'` next to `ContractsStore`; the new types come through `export * from './schema'` automatically (verify with `pnpm --filter @manta/bus build`).
- Modify: `packages/manta-bus/src/tools/index.ts:15-24` — add `casts: CastsStore;` field to `BusContext`. `SubsetContext<K> = Pick<BusContext, K>` at line 26 needs no edit.
- Modify: `packages/manta-bus/src/server.ts:80-99` — `createBusServer` instantiates `new CastsStore(paths, clock)` and adds `casts` to the `context` literal in the same way `contracts`/`registry` are wired.
- Modify: `packages/manta-bus/README.md` — list new state module under "On-disk layout".
- Modify: `packages/manta-bus/ARCHITECTURE.md` — paragraph on cast manifest under existing "State files" section.
- Modify: `packages/manta-cli/src/spawner/clone-spawner.ts:80-93` — `register` call gets `metadata.cast_mode`; new `casts.create(...)` call (idempotent across all clones of the cast).
- Modify: `packages/manta-cli/src/commands/cast.ts:130-181` — pass cast metadata (mode, default policy stub, intended roster) to spawner. Default policy in this chunk is `{ peer_messaging: 'allowed', auto_merge_threshold: null }` for every mode; Chunk 2 replaces the stub with mode-aware policy.
- Modify: `docs/user/cast-manifest.md` (NEW — this file does not exist) — short operator-facing reference for the manifest schema; linked from `docs/user/recon-swarm.md` and (in Chunk 2) from `docs/user/forking-realities.md`. Phase 1's recon-swarm doc already exists per `git log -- docs/user/recon-swarm.md`; we add a one-liner link there.

**Why these boundaries (file-by-file rationale):**
- `state/canonicalize.ts` exists because `state/contracts.ts` and `state/casts.ts` both need stable equality on nested objects. The current private helper at `state/contracts.ts:24-35` already documents the right invariant ("sort keys; do not sort arrays — array order is semantically meaningful"). Two callers crosses the DRY threshold; extraction is preferable to duplication of a recursive function with subtle correctness reasoning.
- `state/casts.ts` is a peer of `state/contracts.ts` and `state/registry.ts`: same `atomicMutateJson` pattern, same `Clock` injection, same `BusConflictError`/`BusNotFoundError` semantics. Putting cast data in a new file (instead of bolting fields onto `RegistryFile`) keeps "per-clone state" and "per-cast state" separate — the registry tracks lifecycle of clones; the manifest records the cast that spawned them. Mixing them would force every reader of one to deserialize the other.
- `schema.ts` gets four new exported schemas — `CastPolicySchema` (the per-cast policy: peer-messaging, auto-merge threshold), `CloneAssignmentSchema` (per-clone overlay reused by the CLI parser in Chunk 2), `CastManifestSchema` (the on-disk shape), `CreateCastInputSchema` (the public store API). Centralising schema in one file is the existing pattern (`RegisterInputSchema`, `TaskContractSchema`, etc. already live there).
- `paths.ts` extension is two lines, follows the same `contractFile(cloneId)` precedent. Putting path math in one file keeps `state/casts.ts` from re-implementing path joining and validation.
- `clone-spawner.ts` is the *only* place that owns the spawn-time write path; a higher-level "cast started" event would re-implement spawner state. Keeping the call here means the manifest's existence is bound to the clone-pre-registration invariant we already trust.
- `cast.ts` only changes the *input* it hands the spawner: it computes the intended roster (`cloneIds`) and hands the cast-level mode + policy down. The spawner stays stateless about cast-level concerns beyond what the snapshot carries.

### File size sanity check

`packages/manta-bus/src/state/casts.ts` is projected at ~120 LOC. `packages/manta-bus/tests/state/casts.test.ts` projected at ~250 LOC (~10 cases × 20-25 LOC each). `packages/manta-bus/src/schema.ts` grows by ~50 LOC; current size is 196, post-Chunk-1 target ~246 — still comfortably reviewable. `packages/manta-cli/src/spawner/clone-spawner.ts` grows by ~30 LOC (manifest-write branch + a guard for "first clone of cast" idempotency); current size 235, post-Chunk-1 target ~265. No file crosses the "hard to reason about as a whole" threshold.

### Tasks

- [ ] **1.0: Extract `canonicalize` helper (refactor — green-to-green)**

**Files:**
- Create: `packages/manta-bus/src/state/canonicalize.ts`
- Create: `packages/manta-bus/tests/state/canonicalize.test.ts`
- Modify: `packages/manta-bus/src/state/contracts.ts:9-35` — drop the private helper, import from new module.

```ts
// packages/manta-bus/src/state/canonicalize.ts
/**
 * Recursively canonicalize a value for stable equality comparison:
 *   - Object keys are sorted alphabetically (insertion-order-independent).
 *   - Arrays are left in their original order — array order may carry
 *     semantic meaning in our schemas (e.g. `sibling_clones` priority,
 *     `allowed_paths` precedence). Sorting them would silently equate
 *     semantically-different shapes.
 *   - Primitives are returned as-is.
 *
 * Original site: state/contracts.ts (Phase 0b). Extracted in Phase 2a when
 * state/casts.ts became a second caller — sharing avoids drift on a
 * recursive function with subtle correctness reasoning.
 */
export function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v !== null && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj)
        .sort()
        .map((k) => [k, canonicalize(obj[k])]),
    );
  }
  return v;
}
```

```ts
// packages/manta-bus/tests/state/canonicalize.test.ts
import { describe, it, expect } from 'vitest';
import { canonicalize } from '../../src/state/canonicalize';

describe('canonicalize', () => {
  it('returns primitives unchanged', () => {
    expect(canonicalize(1)).toBe(1);
    expect(canonicalize('s')).toBe('s');
    expect(canonicalize(null)).toBe(null);
    expect(canonicalize(undefined)).toBe(undefined);
    expect(canonicalize(true)).toBe(true);
  });

  it('sorts object keys alphabetically', () => {
    const out = canonicalize({ b: 1, a: 2 }) as Record<string, number>;
    expect(Object.keys(out)).toEqual(['a', 'b']);
  });

  it('preserves array order', () => {
    expect(canonicalize([3, 1, 2])).toEqual([3, 1, 2]);
  });

  it('recurses into nested objects + arrays', () => {
    const out = JSON.stringify(canonicalize({ z: [{ b: 1, a: 2 }, { d: 3 }], a: 1 }));
    expect(out).toBe('{"a":1,"z":[{"a":2,"b":1},{"d":3}]}');
  });

  it('two key-permuted objects stringify identically', () => {
    const a = JSON.stringify(canonicalize({ task: 't', budget_usd: 5 }));
    const b = JSON.stringify(canonicalize({ budget_usd: 5, task: 't' }));
    expect(a).toBe(b);
  });
});
```

Then update `state/contracts.ts`:
```diff
- import { atomicMutateJson, atomicReadJson } from '../atomic-fs';
+ import { atomicMutateJson, atomicReadJson } from '../atomic-fs';
+ import { canonicalize } from './canonicalize';

- /**
-  * Recursively canonicalize ...
-  */
- function canonicalize(v: unknown): unknown {
-   ...12 lines...
- }
```

Run: `pnpm --filter @manta/bus test`
Expected: existing contracts tests stay green (same algorithm), new canonicalize tests green.

Commit (atomic refactor — separate from manifest infra so a regression bisects clean):

```bash
# CLAUDE.md HARD RULE: take author from `git log`. Two separate calls —
# author names with spaces ("Tim Hunt") would break ${VAR% *} parsing of
# a combined "%ae %an" string.
EMAIL="$(git log -1 --format='%ae')"
NAME="$(git log -1 --format='%an')"
git -c user.email="$EMAIL" -c user.name="$NAME" commit -m "$(cat <<'EOF'
refactor(bus): extract canonicalize helper into shared state/canonicalize.ts

Phase 2a Chunk 1 prep — state/casts.ts will be the second caller. Pulls
the recursive key-sort canonicalizer out of state/contracts.ts (where it
has lived as a private helper since Phase 0b) so the equality semantics
are documented in one place. Behaviour identical; existing contracts
tests stay green.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **1.1: Verify Phase 1 + research-prep shipped**

Run: `pnpm -r build && pnpm -r test`
Expected: green sweep (last reported number was 317/317 + 4 e2e SKIPs in INDEX.md row Phase 0f).
If anything fails, STOP — Chunk 1 depends on a green workspace baseline.

Also verify the research deliverables exist:

```bash
test -f docs/research/phase-2-codepath-map.md && \
  test -f docs/research/phase-2-best-of-n-patterns.md && \
  test -f docs/research/phase-2-bus-isolation.md && \
  echo "research present"
```

Expected: `research present`.

- [ ] **1.2: Add cast manifest schemas (failing parser tests first)**

**File:** `packages/manta-bus/tests/state/casts.test.ts` — write the schema-validation half first, before touching `schema.ts`. The store-side tests are added later (Task 1.5); this test is purely zod-parser exercises.

```ts
import { describe, it, expect } from 'vitest';
import {
  CastManifestSchema,
  CastPolicySchema,
  CloneAssignmentSchema,
  CreateCastInputSchema,
} from '@manta/bus';

describe('CastPolicySchema', () => {
  it('accepts a recon-swarm-style policy', () => {
    expect(
      CastPolicySchema.parse({
        peer_messaging: 'allowed',
        auto_merge_threshold: null,
      }),
    ).toEqual({ peer_messaging: 'allowed', auto_merge_threshold: null });
  });

  it('accepts a forking-realities-style policy with a finite threshold', () => {
    const parsed = CastPolicySchema.parse({
      peer_messaging: 'denied',
      auto_merge_threshold: 0.3,
    });
    expect(parsed.peer_messaging).toBe('denied');
    expect(parsed.auto_merge_threshold).toBe(0.3);
  });

  it('rejects unknown peer_messaging values', () => {
    expect(() =>
      CastPolicySchema.parse({ peer_messaging: 'mostly', auto_merge_threshold: null }),
    ).toThrow();
  });

  it('rejects auto_merge_threshold outside [0, 1] when finite', () => {
    expect(() =>
      CastPolicySchema.parse({ peer_messaging: 'denied', auto_merge_threshold: 1.5 }),
    ).toThrow();
    expect(() =>
      CastPolicySchema.parse({ peer_messaging: 'denied', auto_merge_threshold: -0.1 }),
    ).toThrow();
  });
});

describe('CloneAssignmentSchema', () => {
  it('accepts a minimal assignment (task only)', () => {
    expect(CloneAssignmentSchema.parse({ task: 'do the thing' })).toEqual({ task: 'do the thing' });
  });

  it('accepts a full assignment', () => {
    const parsed = CloneAssignmentSchema.parse({
      task: 'rewrite the SQL query for performance',
      approach_hint: 'consider an index on orders.customer_id',
      scope: { allowed_paths: ['db/'], forbidden_paths: ['secrets/'], max_files_changed: 3 },
      budget_usd: 4.5,
      deadline_seconds: 900,
    });
    expect(parsed.task).toMatch(/SQL/);
    expect(parsed.scope?.max_files_changed).toBe(3);
    expect(parsed.budget_usd).toBe(4.5);
  });

  it('rejects empty task strings', () => {
    expect(() => CloneAssignmentSchema.parse({ task: '' })).toThrow();
  });

  it('rejects negative budget_usd', () => {
    expect(() =>
      CloneAssignmentSchema.parse({ task: 't', budget_usd: -0.01 }),
    ).toThrow();
  });
});

describe('CastManifestSchema', () => {
  it('accepts a recon-swarm manifest', () => {
    const parsed = CastManifestSchema.parse({
      version: 1,
      cast_id: 'cast-1700000000000',
      mode: 'recon-swarm',
      clones: [
        { clone_id: 'A', assignment: null },
        { clone_id: 'B', assignment: null },
      ],
      policy: { peer_messaging: 'allowed', auto_merge_threshold: null },
      created_at: 1700000000000,
    });
    expect(parsed.clones).toHaveLength(2);
  });

  it('accepts a forking-realities manifest with assignments', () => {
    const parsed = CastManifestSchema.parse({
      version: 1,
      cast_id: 'cast-1700000000001',
      mode: 'forking-realities',
      clones: [
        { clone_id: 'A', assignment: { task: 'algorithmic approach' } },
        { clone_id: 'B', assignment: { task: 'index-based approach' } },
        { clone_id: 'C', assignment: { task: 'denormalize approach' } },
      ],
      policy: { peer_messaging: 'denied', auto_merge_threshold: null },
      created_at: 1700000000001,
    });
    expect(parsed.policy.peer_messaging).toBe('denied');
  });

  it('rejects an empty roster', () => {
    expect(() =>
      CastManifestSchema.parse({
        version: 1,
        cast_id: 'cast-x',
        mode: 'recon-swarm',
        clones: [],
        policy: { peer_messaging: 'allowed', auto_merge_threshold: null },
        created_at: 1,
      }),
    ).toThrow();
  });

  it('rejects unsafe cast_id (allow-list pattern only)', () => {
    expect(() =>
      CastManifestSchema.parse({
        version: 1,
        cast_id: 'cast/../escape',
        mode: 'recon-swarm',
        clones: [{ clone_id: 'A', assignment: null }],
        policy: { peer_messaging: 'allowed', auto_merge_threshold: null },
        created_at: 1,
      }),
    ).toThrow();
  });

  it('rejects duplicate clone_ids in the roster', () => {
    expect(() =>
      CastManifestSchema.parse({
        version: 1,
        cast_id: 'cast-x',
        mode: 'recon-swarm',
        clones: [
          { clone_id: 'A', assignment: null },
          { clone_id: 'A', assignment: null },
        ],
        policy: { peer_messaging: 'allowed', auto_merge_threshold: null },
        created_at: 1,
      }),
    ).toThrow();
  });

  it('rejects malformed clone_id (allow-list pattern)', () => {
    expect(() =>
      CastManifestSchema.parse({
        version: 1,
        cast_id: 'cast-1',
        mode: 'recon-swarm',
        clones: [{ clone_id: 'A/B', assignment: null }],
        policy: { peer_messaging: 'allowed', auto_merge_threshold: null },
        created_at: 1,
      }),
    ).toThrow();
  });
});

describe('CreateCastInputSchema', () => {
  it('accepts a recon-swarm input', () => {
    const parsed = CreateCastInputSchema.parse({
      cast_id: 'cast-1',
      mode: 'recon-swarm',
      clones: [
        { clone_id: 'A', assignment: null },
        { clone_id: 'B', assignment: null },
      ],
      policy: { peer_messaging: 'allowed', auto_merge_threshold: null },
    });
    expect(parsed.mode).toBe('recon-swarm');
  });

  it('rejects extra keys (strict)', () => {
    expect(() =>
      CreateCastInputSchema.parse({
        cast_id: 'cast-1',
        mode: 'recon-swarm',
        clones: [{ clone_id: 'A', assignment: null }],
        policy: { peer_messaging: 'allowed', auto_merge_threshold: null },
        unknown_field: 'should not survive',
      }),
    ).toThrow();
  });
});
```

- [ ] **1.3: Run the schema tests to verify they fail**

Run: `pnpm --filter @manta/bus test -- tests/state/casts.test.ts`
Expected: every test in the file fails because the schemas aren't exported yet (typescript compile error or "is not a function").

- [ ] **1.4: Add the schemas to `schema.ts`**

**File:** `packages/manta-bus/src/schema.ts` (append before the existing terminal `export type` re-exports — i.e. after the `TaskContractSchema`/`AckContractInputSchema` block that currently ends around line 96).

```ts
// Cast manifest — Sec 7 (best-of-N flow needs cast-level state) + research:
// docs/research/phase-2-codepath-map.md §2.3 (per-cast manifest motivation)
// + docs/research/phase-2-bus-isolation.md §4.4 (forward-compatible policy
// shape so future modes — council/decoy/etc. — slot in without branching on
// `mode === 'forking-realities'`).
export const CastIdSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[A-Za-z0-9_.-]+$/, 'cast_id must match /^[A-Za-z0-9_.-]+$/');

export const CastPolicySchema = z
  .object({
    // Phase 2: 'allowed' (recon-swarm and friends) | 'denied' (forking-realities).
    // String-enum (rather than boolean) is the forward-compatible cut from
    // research §4.4 — a future `peer_messaging: 'role-based'` or 'main-only'
    // slots in additively.
    peer_messaging: z.enum(['allowed', 'denied']),
    // Phase 2: stays null (manual-merge default per research best-of-n §4 hybrid
    // mode); Phase 3+ can set a value in [0, 1]. Null encodes "manual review
    // required" without overloading the number space.
    auto_merge_threshold: z
      .number()
      .min(0)
      .max(1)
      .nullable(),
  })
  .strict();

export const CloneAssignmentSchema = z
  .object({
    task: z.string().min(1).max(8_000).optional(),
    approach_hint: z.string().max(8_000).optional(),
    scope: ScopeSchema.optional(),
    budget_usd: z.number().positive().optional(),
    deadline_seconds: z.number().int().positive().optional(),
  })
  .strict();

const CastClonesEntrySchema = z
  .object({
    clone_id: CloneIdSchema,
    assignment: CloneAssignmentSchema.nullable(),
  })
  .strict();

export const CastManifestSchema = z
  .object({
    version: z.literal(1),
    cast_id: CastIdSchema,
    mode: ModeSchema,
    clones: z
      .array(CastClonesEntrySchema)
      .min(1)
      .refine(
        (xs) => new Set(xs.map((c) => c.clone_id)).size === xs.length,
        { message: 'roster must not contain duplicate clone_ids' },
      ),
    policy: CastPolicySchema,
    created_at: z.number().int().nonnegative(),
  })
  .strict();

export const CreateCastInputSchema = z
  .object({
    cast_id: CastIdSchema,
    mode: ModeSchema,
    clones: z
      .array(CastClonesEntrySchema)
      .min(1)
      .refine(
        (xs) => new Set(xs.map((c) => c.clone_id)).size === xs.length,
        { message: 'roster must not contain duplicate clone_ids' },
      ),
    policy: CastPolicySchema,
  })
  .strict();

export type CastId = z.infer<typeof CastIdSchema>;
export type CastPolicy = z.infer<typeof CastPolicySchema>;
export type CloneAssignment = z.infer<typeof CloneAssignmentSchema>;
export type CastManifest = z.infer<typeof CastManifestSchema>;
export type CreateCastInput = z.infer<typeof CreateCastInputSchema>;
```

Add the corresponding `export type` lines if not already present at the bottom of `schema.ts`.

- [ ] **1.5: Re-run the schema tests to verify they pass**

Run: `pnpm --filter @manta/bus test -- tests/state/casts.test.ts`
Expected: every parser test green. Store-side tests (the rest of the file does not exist yet) are not in this task — coming in Task 1.7.

- [ ] **1.6: Extend `BusPaths` for the cast manifest directory**

**File:** `packages/manta-bus/src/state/paths.ts`

Add to `BusPaths`:

```ts
readonly castsDir: string;
castFile(castId: string): string;
```

Add to `busPaths(repoRoot)`'s return object (mirror the existing `contractFile(cloneId)` pattern):

```ts
castsDir: path.join(stateDir, 'casts'),
castFile(castId: string): string {
  const parsed = CastIdSchema.safeParse(castId);
  if (!parsed.success) {
    throw new Error(`busPaths.castFile: invalid cast_id: ${castId}`);
  }
  return path.join(stateDir, 'casts', `${parsed.data}.json`);
},
```

Import `CastIdSchema` from `../schema` at the top of `paths.ts` next to the existing `CloneIdSchema` import.

**Test the path math** by adding a `paths.test.ts` case (the file already exists from Phase 0b):

```ts
it('busPaths.castFile validates cast_id and joins under stateDir/casts', () => {
  const p = busPaths('/tmp/repo');
  expect(p.castFile('cast-1700000000000')).toBe('/tmp/repo/.manta/state/casts/cast-1700000000000.json');
  expect(() => p.castFile('cast/../bad')).toThrow();
});
```

Run: `pnpm --filter @manta/bus test -- tests/state/paths.test.ts`
Expected: existing cases stay green; new case green.

- [ ] **1.7: Add CastsStore tests (failing first)**

**File:** `packages/manta-bus/tests/state/casts.test.ts` — append (the parser cases from Task 1.2 stay; new cases below them).

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CastsStore } from '@manta/bus';
import { busPaths } from '@manta/bus'; // exported from index per existing pattern
import type { Clock } from '@manta/bus';

function tmpRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'manta-casts-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function fixedClock(t: number): Clock {
  return { now: () => t };
}

describe('CastsStore.create', () => {
  it('writes a manifest and returns it', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const paths = busPaths(dir);
      const store = new CastsStore(paths, fixedClock(1700000000000));
      const manifest = await store.create({
        cast_id: 'cast-A',
        mode: 'recon-swarm',
        clones: [
          { clone_id: 'A', assignment: null },
          { clone_id: 'B', assignment: null },
        ],
        policy: { peer_messaging: 'allowed', auto_merge_threshold: null },
      });
      expect(manifest.created_at).toBe(1700000000000);
      expect(manifest.clones).toHaveLength(2);
      // Persisted on disk under casts/<castId>.json:
      const round = await store.read('cast-A');
      expect(round).toEqual(manifest);
    } finally {
      cleanup();
    }
  });

  it('is idempotent on identical create calls', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const store = new CastsStore(busPaths(dir), fixedClock(1700000000000));
      const input = {
        cast_id: 'cast-B',
        mode: 'recon-swarm' as const,
        clones: [{ clone_id: 'A', assignment: null }],
        policy: { peer_messaging: 'allowed' as const, auto_merge_threshold: null },
      };
      const a = await store.create(input);
      const b = await store.create(input);
      expect(a).toEqual(b);
    } finally {
      cleanup();
    }
  });

  it('rejects re-create with a different roster (BusConflictError)', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const store = new CastsStore(busPaths(dir), fixedClock(1));
      await store.create({
        cast_id: 'cast-C',
        mode: 'recon-swarm',
        clones: [{ clone_id: 'A', assignment: null }],
        policy: { peer_messaging: 'allowed', auto_merge_threshold: null },
      });
      await expect(
        store.create({
          cast_id: 'cast-C',
          mode: 'recon-swarm',
          clones: [{ clone_id: 'A', assignment: null }, { clone_id: 'B', assignment: null }],
          policy: { peer_messaging: 'allowed', auto_merge_threshold: null },
        }),
      ).rejects.toMatchObject({ name: 'BusConflictError' });
    } finally {
      cleanup();
    }
  });

  it('rejects re-create with a different mode (BusConflictError)', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const store = new CastsStore(busPaths(dir), fixedClock(1));
      await store.create({
        cast_id: 'cast-D',
        mode: 'recon-swarm',
        clones: [{ clone_id: 'A', assignment: null }],
        policy: { peer_messaging: 'allowed', auto_merge_threshold: null },
      });
      await expect(
        store.create({
          cast_id: 'cast-D',
          mode: 'forking-realities',
          clones: [{ clone_id: 'A', assignment: null }],
          policy: { peer_messaging: 'denied', auto_merge_threshold: null },
        }),
      ).rejects.toMatchObject({ name: 'BusConflictError' });
    } finally {
      cleanup();
    }
  });

  it('rejects re-create with a different policy (BusConflictError)', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const store = new CastsStore(busPaths(dir), fixedClock(1));
      await store.create({
        cast_id: 'cast-E',
        mode: 'recon-swarm',
        clones: [{ clone_id: 'A', assignment: null }],
        policy: { peer_messaging: 'allowed', auto_merge_threshold: null },
      });
      await expect(
        store.create({
          cast_id: 'cast-E',
          mode: 'recon-swarm',
          clones: [{ clone_id: 'A', assignment: null }],
          policy: { peer_messaging: 'denied', auto_merge_threshold: null },
        }),
      ).rejects.toMatchObject({ name: 'BusConflictError' });
    } finally {
      cleanup();
    }
  });

  it('preserves original created_at on idempotent re-create (clock-skew safe)', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      let t = 1700000000000;
      const store = new CastsStore(busPaths(dir), { now: () => t });
      const input = {
        cast_id: 'cast-F',
        mode: 'recon-swarm' as const,
        clones: [{ clone_id: 'A', assignment: null }],
        policy: { peer_messaging: 'allowed' as const, auto_merge_threshold: null },
      };
      const a = await store.create(input);
      t += 5_000;
      const b = await store.create(input); // idempotent: must keep a.created_at
      expect(b.created_at).toBe(a.created_at);
    } finally {
      cleanup();
    }
  });

  it('treats key-order-permuted assignments as identical (canonicalize)', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const store = new CastsStore(busPaths(dir), fixedClock(1));
      await store.create({
        cast_id: 'cast-G',
        mode: 'forking-realities',
        clones: [{ clone_id: 'A', assignment: { task: 't', budget_usd: 5 } }],
        policy: { peer_messaging: 'denied', auto_merge_threshold: null },
      });
      // Same content, different key insertion order — must NOT be a conflict.
      await expect(
        store.create({
          cast_id: 'cast-G',
          mode: 'forking-realities',
          clones: [{ clone_id: 'A', assignment: { budget_usd: 5, task: 't' } }],
          policy: { peer_messaging: 'denied', auto_merge_threshold: null },
        }),
      ).resolves.toBeDefined();
    } finally {
      cleanup();
    }
  });

  it('invokes auditAppend when provided (Phase 2c hook)', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const store = new CastsStore(busPaths(dir), fixedClock(1));
      const calls: string[] = [];
      await store.create(
        {
          cast_id: 'cast-H',
          mode: 'recon-swarm',
          clones: [{ clone_id: 'A', assignment: null }],
          policy: { peer_messaging: 'allowed', auto_merge_threshold: null },
        },
        async () => {
          calls.push('audit');
        },
      );
      expect(calls).toEqual(['audit']);
    } finally {
      cleanup();
    }
  });
});

describe('CastsStore.read', () => {
  it('throws BusNotFoundError on missing cast_id', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const store = new CastsStore(busPaths(dir), fixedClock(1));
      await expect(store.read('cast-nope')).rejects.toMatchObject({ name: 'BusNotFoundError' });
    } finally {
      cleanup();
    }
  });
});

describe('CastsStore.list', () => {
  it('returns [] on a fresh repo', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const store = new CastsStore(busPaths(dir), fixedClock(1));
      expect(await store.list()).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('returns every persisted manifest', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const store = new CastsStore(busPaths(dir), fixedClock(1));
      await store.create({
        cast_id: 'cast-1',
        mode: 'recon-swarm',
        clones: [{ clone_id: 'A', assignment: null }],
        policy: { peer_messaging: 'allowed', auto_merge_threshold: null },
      });
      await store.create({
        cast_id: 'cast-2',
        mode: 'forking-realities',
        clones: [{ clone_id: 'A', assignment: { task: 'one' } }, { clone_id: 'B', assignment: { task: 'two' } }],
        policy: { peer_messaging: 'denied', auto_merge_threshold: null },
      });
      const all = await store.list();
      expect(all.map((m) => m.cast_id).sort()).toEqual(['cast-1', 'cast-2']);
    } finally {
      cleanup();
    }
  });
});
```

Run: `pnpm --filter @manta/bus test -- tests/state/casts.test.ts`
Expected: every store test fails with "CastsStore is not a constructor" / module-not-found until Task 1.8 implements it.

- [ ] **1.8: Implement `CastsStore`**

**File (new):** `packages/manta-bus/src/state/casts.ts`

The signature of `atomicMutateJson` is `(filePath, defaultFactory, mutator, auditAppend?)` per `packages/manta-bus/src/atomic-fs.ts:81-86`. The signature of `atomicReadJson<T>` is `(filePath, defaultFn?: () => T)` per `state/contracts.ts:90` — pass a default factory rather than wrap with `.catch(ENOENT)`.

```ts
import { atomicMutateJson, atomicReadJson } from '../atomic-fs';
import type { Clock } from '../clock';
import { BusConflictError, BusNotFoundError } from '../errors';
import type { CastManifest, CreateCastInput } from '../schema';
import {
  CastManifestSchema,
  CreateCastInputSchema,
} from '../schema';
import type { BusPaths } from './paths';
import { canonicalize } from './canonicalize';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Per-cast state. Records the cast's mode, roster, and policy at spawn time.
 *
 * Each manifest is one file at `BusPaths.castFile(castId)`; `BusPaths.castsDir`
 * is the parent directory. The file is written atomically via `atomicMutateJson`
 * (same primitive `Registry`/`Contracts` use), so concurrent spawn attempts on
 * the same cast_id resolve cleanly: the first wins, the second sees the
 * existing manifest and (on identical content) succeeds idempotently.
 *
 * Phase 2 readers: bus filter (Phase 2b — sibling messaging), orchestrator
 * (Phase 2c — finalised-cast detection), CLI (Phase 2d — replay/audit).
 */
export class CastsStore {
  constructor(private readonly paths: BusPaths, private readonly clock: Clock) {}

  /**
   * Create a new manifest. Idempotent: re-create with the *same* content
   * returns the existing manifest unchanged (preserves the original
   * `created_at`). Re-create with *different* content (different mode,
   * different roster, different policy) throws BusConflictError — never
   * silently overwrites.
   */
  async create(
    rawInput: CreateCastInput,
    auditAppend?: () => Promise<void>,
  ): Promise<CastManifest> {
    const input = CreateCastInputSchema.parse(rawInput);
    await fs.mkdir(this.paths.castsDir, { recursive: true });
    const file = this.paths.castFile(input.cast_id);
    return atomicMutateJson<CastManifest>(
      file,
      // Default factory: only consulted when the file does not yet exist.
      // We stamp the creation timestamp here so repeated calls (after
      // idempotent return) do NOT clobber the original — the mutator below
      // returns `current` unchanged on identical input.
      () => ({
        version: 1,
        cast_id: input.cast_id,
        mode: input.mode,
        clones: input.clones,
        policy: input.policy,
        created_at: this.clock.now(),
      }),
      (current) => {
        // First-write path: defaultFactory's value is what `current` is. No
        // conflict checks needed — atomicMutateJson will write `current`
        // directly. We DO have to detect "first write" vs "already-existed"
        // because the conflict checks below assume an existing manifest.
        // The marker: `current.created_at === this.clock.now()` is racy; a
        // robust marker is `written_at === 0`-style sentinel, but our
        // CastManifest schema requires `created_at` non-negative and we'd
        // need a sentinel field. Simpler: check whether the file body
        // actually existed BEFORE this call by reading the file once
        // upfront and short-circuiting. That breaks atomicity. The cleanest
        // shape: compare `current` against the desired-without-timestamp
        // shape; if they match modulo created_at, this is either
        // (a) first-write (defaultFactory) or (b) idempotent rewrite — both
        // succeed by returning `current`.
        const sameMode = current.mode === input.mode;
        const sameRosterAndAssignments =
          JSON.stringify(canonicalize(current.clones)) ===
          JSON.stringify(canonicalize(input.clones));
        const samePolicy =
          JSON.stringify(canonicalize(current.policy)) ===
          JSON.stringify(canonicalize(input.policy));
        if (sameMode && sameRosterAndAssignments && samePolicy) {
          return current; // first-write OR identical idempotent rewrite
        }
        if (!sameMode) {
          throw new BusConflictError(
            `cast ${input.cast_id} already exists with mode=${current.mode}; refused to overwrite with mode=${input.mode}`,
          );
        }
        if (!sameRosterAndAssignments) {
          throw new BusConflictError(
            `cast ${input.cast_id} already exists with a different roster or per-clone assignments`,
          );
        }
        // Must be policy.
        throw new BusConflictError(
          `cast ${input.cast_id} already exists with a different policy`,
        );
      },
      auditAppend,
    );
  }

  async read(castId: string): Promise<CastManifest> {
    const file = this.paths.castFile(castId);
    const raw = await atomicReadJson<CastManifest | null>(file, () => null);
    if (raw == null) throw new BusNotFoundError('cast', castId);
    return CastManifestSchema.parse(raw);
  }

  async list(): Promise<CastManifest[]> {
    const files = await fs.readdir(this.paths.castsDir).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return [] as string[];
      throw err;
    });
    const out: CastManifest[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const raw = await atomicReadJson<CastManifest | null>(
        path.join(this.paths.castsDir, f),
        () => null,
      );
      if (raw != null) out.push(CastManifestSchema.parse(raw));
    }
    return out;
  }
}
```

Why no separate `sameClones` helper: equality is now a single `JSON.stringify(canonicalize(...))` round-trip, identical to the `state/contracts.ts:71-74` pattern. The roster/assignments comparison is one expression, so a named helper would obscure rather than clarify.

- [ ] **1.9: Re-run the store tests to verify they pass**

Run: `pnpm --filter @manta/bus test -- tests/state/casts.test.ts`
Expected: every test green (parser + store).

Then run the whole `@manta/bus` sweep to confirm no regressions:

```bash
pnpm --filter @manta/bus test
```

Expected: everything green; coverage ≥ 80% on the new file (vitest reports per-file coverage by default in `@manta/bus/vitest.config.ts`).

- [ ] **1.10: Wire `CastsStore` into `BusContext`**

The `BusContext` interface lives at `packages/manta-bus/src/tools/index.ts:15-24`. The canonical construction site is `packages/manta-bus/src/server.ts:80-99` inside `createBusServer`. `SubsetContext<K> = Pick<BusContext, K>` at `tools/index.ts:26` derives from `BusContext` automatically — no separate edit needed there.

**File:** `packages/manta-bus/src/tools/index.ts`

Add to imports + interface:

```diff
  import type { ContractsStore } from '../state/contracts';
+ import type { CastsStore } from '../state/casts';
  import type { EventsLog } from '../state/events';
```

```diff
  export interface BusContext {
    paths: BusPaths;
    clock: Clock;
    registry: Registry;
    locks: LocksStore;
    claims: ClaimsStore;
    contracts: ContractsStore;
+   casts: CastsStore;
    events: EventsLog;
    memoryWriters: MemoryWriters;
  }
```

**File:** `packages/manta-bus/src/server.ts:80-99`

```diff
  const contracts = new ContractsStore(paths, clock);
+ const casts = new CastsStore(paths, clock);
  const events = new EventsLog(paths, clock);
  const memoryWriters =
    opts.memoryWriters ?? fsMemoryWriters({ repoRoot: opts.repoRoot, clock });
  const context: BusContext = {
    paths,
    clock,
    registry,
    locks,
    claims,
    contracts,
+   casts,
    events,
    memoryWriters,
  };
```

Add the import for `CastsStore` at the top of `server.ts` next to the existing store imports.

Run: `pnpm --filter @manta/bus build && pnpm --filter @manta/bus test`
Expected: green TypeScript build; existing tests stay green (no test consumes `BusContext.casts` yet — Task 1.16 introduces the integration test that does).

- [ ] **1.11: Export new types from `@manta/bus` index**

**File:** `packages/manta-bus/src/index.ts`

Add to the existing re-exports:

```ts
export { CastsStore } from './state/casts';
export type {
  CastId,
  CastPolicy,
  CloneAssignment,
  CastManifest,
  CreateCastInput,
} from './schema';
export {
  CastIdSchema,
  CastPolicySchema,
  CloneAssignmentSchema,
  CastManifestSchema,
  CreateCastInputSchema,
} from './schema';
```

Run: `pnpm --filter @manta/bus build && pnpm --filter @manta/cli build`
Expected: both green. The CLI now sees `CastsStore` etc. through the package boundary — Chunk 2 will use this.

- [ ] **1.12: Spawner-side: write the manifest on the first clone of a cast**

**File:** `packages/manta-cli/src/spawner/clone-spawner.ts`

The current spawner's `register` block is at lines 80-93 (verified in this session). The change shape:

1. Extend `SpawnCloneOptions` with a `casts: CastsCreator` field — narrow seam, mirroring the `RegistryWriter` pattern at lines 27-29:

```ts
export interface CastsCreator {
  create(input: CreateCastInput): Promise<CastManifest>;
}

export interface SpawnCloneOptions {
  repoRoot: string;
  snapshot: Snapshot;
  worktree: string;
  runner: CloneRunner;
  registry: RegistryWriter;
  casts: CastsCreator;
  /** Cast-level info needed to write/extend the manifest. */
  castMode: Mode;
  castPolicy: CastPolicy;
  /**
   * Full intended roster of clone_ids for this cast (in spawn order). The
   * spawner uses this to write the manifest on first clone of the cast; on
   * subsequent clones the manifest already exists and `casts.create` is
   * idempotent (same input).
   */
  castRoster: ReadonlyArray<{ clone_id: string; assignment: CloneAssignment | null }>;
}
```

2. After the `await opts.registry.register(...)` call (lines 81-87), add:

```ts
// Cast manifest is per-cast, not per-clone. We call `casts.create` for every
// clone in the cast — `CastsStore.create` is idempotent on identical input,
// so the first call writes the manifest and subsequent calls are no-ops.
// This avoids a "first-clone-special" branch and survives clone-A failing
// to spawn (clone-B's call still creates the manifest).
try {
  await opts.casts.create({
    cast_id: castId,
    mode: opts.castMode,
    clones: [...opts.castRoster],
    policy: opts.castPolicy,
  });
} catch (cause) {
  throw new CliError(`failed to create cast manifest for ${castId}`, {
    kind: 'register_failed',
    cause,
  });
}
```

3. Update `metadata: { cast_id: castId }` to also carry `cast_mode`:

```ts
metadata: { cast_id: castId, cast_mode: opts.castMode },
```

(Reason: research §4.3 — bus filter joins on `cast_mode` without round-tripping the registry for sibling lookup.)

Imports added at the top of `clone-spawner.ts`:

```ts
import type { CastManifest, CastPolicy, CloneAssignment, CreateCastInput, Mode } from '@manta/bus';
```

- [ ] **1.13: Spawner test — manifest is written, idempotent across clones**

**File:** `packages/manta-cli/tests/spawner/clone-spawner.test.ts` (this file exists from Phase 0d — append).

The Phase 0d test file already has a `fakeRegistry` helper (run `grep -n "fakeRegistry\|RegistryWriter" packages/manta-cli/tests/spawner/clone-spawner.test.ts | head -10` to confirm). Add a parallel `fakeCasts` helper at the top of the test module:

```ts
import type { CreateCastInput, CastManifest } from '@manta/bus';
import type { CastsCreator } from '../../src/spawner/clone-spawner';

function makeFakeCasts(opts?: { rejectWith?: Error }): { creator: CastsCreator; calls: CreateCastInput[] } {
  const calls: CreateCastInput[] = [];
  return {
    creator: {
      async create(input) {
        calls.push(input);
        if (opts?.rejectWith) throw opts.rejectWith;
        const manifest: CastManifest = {
          version: 1,
          cast_id: input.cast_id,
          mode: input.mode,
          clones: input.clones,
          policy: input.policy,
          created_at: 1700000000000,
        };
        return manifest;
      },
    },
    calls,
  };
}
```

Then the three test cases (full bodies — no skeletons):

```ts
it('writes the cast manifest input identically across two spawnClone calls', async () => {
  const reg = makeFakeRegistry();
  const casts = makeFakeCasts();
  const roster = [
    { clone_id: 'A', assignment: null },
    { clone_id: 'B', assignment: null },
  ];
  const policy = { peer_messaging: 'allowed' as const, auto_merge_threshold: null };
  const snapA = makeSnapshotForTest({ cloneId: 'A', castId: 'cast-spawn-1' });
  const snapB = makeSnapshotForTest({ cloneId: 'B', castId: 'cast-spawn-1' });
  await spawnClone({
    repoRoot: tmpRepo,
    snapshot: snapA,
    worktree: `${tmpRepo}/.manta/worktrees/clone-A`,
    runner: fakeCloneRunner,
    registry: reg.writer,
    casts: casts.creator,
    castMode: 'recon-swarm',
    castPolicy: policy,
    castRoster: roster,
  });
  await spawnClone({
    repoRoot: tmpRepo,
    snapshot: snapB,
    worktree: `${tmpRepo}/.manta/worktrees/clone-B`,
    runner: fakeCloneRunner,
    registry: reg.writer,
    casts: casts.creator,
    castMode: 'recon-swarm',
    castPolicy: policy,
    castRoster: roster,
  });
  expect(casts.calls).toHaveLength(2);
  expect(casts.calls[0]).toEqual(casts.calls[1]);
  expect(casts.calls[0]!.cast_id).toBe('cast-spawn-1');
});

it('throws CliError(register_failed) with cause when casts.create rejects', async () => {
  const reg = makeFakeRegistry();
  const cause = new Error('disk full');
  const casts = makeFakeCasts({ rejectWith: cause });
  const snap = makeSnapshotForTest({ cloneId: 'A', castId: 'cast-spawn-2' });
  await expect(
    spawnClone({
      repoRoot: tmpRepo,
      snapshot: snap,
      worktree: `${tmpRepo}/.manta/worktrees/clone-A`,
      runner: fakeCloneRunner,
      registry: reg.writer,
      casts: casts.creator,
      castMode: 'recon-swarm',
      castPolicy: { peer_messaging: 'allowed', auto_merge_threshold: null },
      castRoster: [{ clone_id: 'A', assignment: null }],
    }),
  ).rejects.toMatchObject({ kind: 'register_failed' });
  // Registry record was already written before casts.create — verify no
  // best-effort rollback (cleanup is cast.ts's concern, not the spawner's).
  const all = await reg.list();
  expect(all.find((r) => r.clone_id === 'A')).toBeDefined();
});

it('passes metadata.cast_mode and metadata.cast_id to registry.register', async () => {
  const reg = makeFakeRegistry();
  const casts = makeFakeCasts();
  const snap = makeSnapshotForTest({ cloneId: 'A', castId: 'cast-spawn-3' });
  await spawnClone({
    repoRoot: tmpRepo,
    snapshot: snap,
    worktree: `${tmpRepo}/.manta/worktrees/clone-A`,
    runner: fakeCloneRunner,
    registry: reg.writer,
    casts: casts.creator,
    castMode: 'forking-realities',
    castPolicy: { peer_messaging: 'denied', auto_merge_threshold: null },
    castRoster: [{ clone_id: 'A', assignment: null }],
  });
  const inputs = reg.inputs();
  expect(inputs).toHaveLength(1);
  expect(inputs[0]!.metadata).toEqual({
    cast_id: 'cast-spawn-3',
    cast_mode: 'forking-realities',
  });
});
```

`makeFakeRegistry`/`makeSnapshotForTest`/`tmpRepo`/`fakeCloneRunner` are existing Phase-0d helpers — copy the import lines from existing tests in the same file.

Run: `pnpm --filter @manta/cli test -- tests/spawner/clone-spawner.test.ts`
Expected: every existing test plus the three new ones green.

- [ ] **1.14: cast.ts wires the manifest-write inputs**

**File:** `packages/manta-cli/src/commands/cast.ts`

In the spawn loop (currently lines 130-181), the `spawnClone({...})` call needs the new fields. Compute the cast-level mode + policy + roster *before* the loop. Phase 2a uses default policies; Chunk 2 introduces real policy plumbing. So for Chunk 1:

```ts
// Default policy for any cast — Chunk 2 adjusts it for forking-realities.
const castPolicy: CastPolicy = {
  peer_messaging: 'allowed',
  auto_merge_threshold: null,
};
const castRoster = cloneIds.map((id) => ({ clone_id: id, assignment: null }));

for (const cloneId of cloneIds) {
  // ... existing worktree + snapshot creation ...
  const handle = await spawnClone({
    repoRoot: rt.repoRoot,
    snapshot: snap,
    worktree: wt.path,
    runner: opts.runner,
    registry: rt.ctx.registry,
    casts: rt.ctx.casts,
    castMode: opts.mode,
    castPolicy,
    castRoster,
  });
  // ...
}
```

The `runtime.ts` composer already exposes `rt.ctx` → `BusContext`; with Chunk 1 Task 1.10 done, `rt.ctx.casts` is populated.

- [ ] **1.15: Run the entire CLI sweep + full workspace sweep**

Run:
```bash
pnpm --filter @manta/cli test && \
  pnpm -r build && \
  pnpm -r test
```

Expected: every test green (no regressions); the new CLI tests from Task 1.13 included.

`spawnClone`'s new fields (`casts`, `castMode`, `castPolicy`, `castRoster`) have **no defaults** — every existing call site must pass them explicitly. Phase 0d's `clone-spawner.test.ts` is the only existing direct caller; cast.ts is updated in Task 1.14. If a Phase-0d test fails because it omitted the new fields, update its `spawnClone(...)` call to pass `casts: makeFakeCasts().creator`, `castMode: 'recon-swarm'`, `castPolicy: { peer_messaging: 'allowed', auto_merge_threshold: null }`, and a `castRoster` derived from the snapshot's `cloneId`. Do not introduce default-arg shims — explicit call sites are the project's "no hidden ambient state" preference.

- [ ] **1.16: Integration test — manifest survives a full mocked cast lifecycle**

**File (new):** `packages/manta-bus/tests/integration/cast-manifest.test.ts`

The public entry point is `createBusServer({ repoRoot, clock? })` from `@manta/bus` (`src/index.ts:18`). It returns a `BusServerHandle` whose `context: BusContext` is `@internal` but exposed for in-process tests (see `server.ts:37-47`). We use `handle.context.casts.*` directly — same pattern other `@manta/bus` integration tests use (verify by `grep -rn "createBusServer" packages/manta-bus/tests/`).

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBusServer, systemClock } from '@manta/bus';

describe('cast-manifest integration', () => {
  it('survives handle restart via on-disk persistence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'manta-cast-int-'));
    try {
      const h1 = await createBusServer({ repoRoot: dir, clock: systemClock });
      await h1.context.casts.create({
        cast_id: 'cast-int-1',
        mode: 'recon-swarm',
        clones: [{ clone_id: 'A', assignment: null }, { clone_id: 'B', assignment: null }],
        policy: { peer_messaging: 'allowed', auto_merge_threshold: null },
      });
      // Simulate process exit + new handle pointing at the same dir.
      const h2 = await createBusServer({ repoRoot: dir, clock: systemClock });
      const round = await h2.context.casts.read('cast-int-1');
      expect(round.clones).toHaveLength(2);
      expect(round.mode).toBe('recon-swarm');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('two concurrent create attempts on same cast_id resolve to one manifest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'manta-cast-int-'));
    try {
      const h = await createBusServer({ repoRoot: dir, clock: systemClock });
      const input = {
        cast_id: 'cast-int-2',
        mode: 'recon-swarm' as const,
        clones: [{ clone_id: 'A', assignment: null }],
        policy: { peer_messaging: 'allowed' as const, auto_merge_threshold: null },
      };
      const [a, b] = await Promise.all([
        h.context.casts.create(input),
        h.context.casts.create(input),
      ]);
      expect(a.cast_id).toBe('cast-int-2');
      expect(b.cast_id).toBe('cast-int-2');
      // Mutex serialises; second call sees the first's write, returns the
      // existing record (preserving its created_at). Wallclock skew between
      // the two scheduling points cannot leak into either record.
      expect(a.created_at).toBe(b.created_at);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('list() returns every persisted manifest after a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'manta-cast-int-'));
    try {
      const h1 = await createBusServer({ repoRoot: dir, clock: systemClock });
      await h1.context.casts.create({
        cast_id: 'cast-list-1',
        mode: 'recon-swarm',
        clones: [{ clone_id: 'A', assignment: null }],
        policy: { peer_messaging: 'allowed', auto_merge_threshold: null },
      });
      await h1.context.casts.create({
        cast_id: 'cast-list-2',
        mode: 'forking-realities',
        clones: [
          { clone_id: 'A', assignment: { task: 'one' } },
          { clone_id: 'B', assignment: { task: 'two' } },
        ],
        policy: { peer_messaging: 'denied', auto_merge_threshold: null },
      });
      const h2 = await createBusServer({ repoRoot: dir, clock: systemClock });
      const all = await h2.context.casts.list();
      expect(all.map((m) => m.cast_id).sort()).toEqual(['cast-list-1', 'cast-list-2']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

Run: `pnpm --filter @manta/bus test -- tests/integration/cast-manifest.test.ts`
Expected: all three tests green.

- [ ] **1.17: README + ARCHITECTURE updates**

**File:** `packages/manta-bus/README.md` — under the existing "On-disk layout" section, add a row:

```
.manta/state/casts/<castId>.json    cast manifest — mode, roster, policy (Phase 2)
```

**File:** `packages/manta-bus/ARCHITECTURE.md` — append a paragraph in the "State files" section:

```
## Cast manifest

`CastsStore` (state/casts.ts) records one document per cast at
`.manta/state/casts/<castId>.json`. The manifest captures cast-level state
that does not belong on per-clone records: the cast's mode, its roster of
clone_ids, and its policy (peer messaging allowed/denied, auto-merge
threshold). The store is `atomicMutateJson`-backed and idempotent on
identical input — the spawner calls `casts.create` for every clone of every
cast, and the first call wins.

Phase 2 readers: bus filter (sibling messaging — Phase 2b),
orchestrator (cast finalisation — Phase 2c), CLI (replay/audit — Phase 2d).
```

- [ ] **1.18: Operator-facing doc — cast manifest reference**

**File (new):** `docs/user/cast-manifest.md`

Operator reference for the manifest. ~50 lines. Covers: file location (`.manta/state/casts/<castId>.json`), schema fields (link to `packages/manta-bus/src/schema.ts`), idempotency semantics ("safe to reload — first writer wins; identical re-write is a no-op; conflicting re-write is a hard error"), what reads it (Phase 2b filter, Phase 2c orchestrator, Phase 2d `replay`/`audit`). Manifest applies to ALL casts, not just one mode — so the doc lives at the cast-level location, not under any mode page.

**File:** `docs/user/recon-swarm.md` (existing — verify with `git log -- docs/user/recon-swarm.md` that Phase 1 shipped it)

Add a one-liner under "What recon-swarm produces":

```
* A cast manifest at `.manta/state/casts/<castId>.json` — see
  [docs/user/cast-manifest.md](./cast-manifest.md). Same file is written for
  every cast mode; nothing recon-swarm-specific.
```

(Chunk 2 Task 2.12 adds the parallel link from `forking-realities.md`.)

- [ ] **1.19: Commit Chunk 1 (manifest infrastructure commit, after Task 1.0's earlier refactor commit)**

The canonicalize extraction in Task 1.0 already shipped as its own commit. This commit covers everything else added by Chunk 1.

```bash
git add packages/manta-bus/src/state/casts.ts \
        packages/manta-bus/src/state/paths.ts \
        packages/manta-bus/src/schema.ts \
        packages/manta-bus/src/tools/index.ts \
        packages/manta-bus/src/server.ts \
        packages/manta-bus/src/index.ts \
        packages/manta-bus/tests/state/casts.test.ts \
        packages/manta-bus/tests/state/paths.test.ts \
        packages/manta-bus/tests/integration/cast-manifest.test.ts \
        packages/manta-bus/README.md \
        packages/manta-bus/ARCHITECTURE.md \
        packages/manta-cli/src/spawner/clone-spawner.ts \
        packages/manta-cli/src/commands/cast.ts \
        packages/manta-cli/tests/spawner/clone-spawner.test.ts \
        docs/user/cast-manifest.md \
        docs/user/recon-swarm.md

# CLAUDE.md HARD RULE: take author from a single `git log -1 --format='%ae %an'`.
# CLAUDE.md HARD RULE: take author from `git log`. Two separate calls —
# author names with spaces ("Tim Hunt") would break ${VAR% *} parsing of
# a combined "%ae %an" string.
EMAIL="$(git log -1 --format='%ae')"
NAME="$(git log -1 --format='%an')"
git -c user.email="$EMAIL" -c user.name="$NAME" commit -m "$(cat <<'EOF'
feat(phase-2a): cast manifest infrastructure + cast_mode registry metadata

New @manta/bus state module: CastsStore at .manta/state/casts/<castId>.json
records mode + roster + policy per cast. Spawner writes one manifest per cast
(idempotent across all clones; first wins) and tags registry metadata with
cast_mode so the Phase 2b filter has its join key from day 1.

* CastIdSchema / CastPolicySchema / CloneAssignmentSchema / CastManifestSchema
  / CreateCastInputSchema (zod, .strict())
* CastsStore.{create,read,list} via atomicMutateJson (mirrors Registry/Contracts);
  canonicalize-based equality (extracted helper from state/contracts.ts shared
  via state/canonicalize.ts in the prior commit)
* BusPaths.castsDir + castFile(castId)
* BusContext.casts wired in tools/index.ts + server.ts
* clone-spawner: registry.metadata.cast_mode + casts.create per clone
* Recon-swarm casts now also leave a manifest (backward-compatible)

Tests: schema-parser sweep (13 cases), CastsStore unit (9 cases including
policy-conflict and key-permutation idempotency and auditAppend hook),
integration suite (3 cases: persistence across handle restart, concurrent-
create idempotency, list across restart). Spawner sweep gains 3 cases
(manifest input parity, register_failed propagation, metadata.cast_mode
plumbing). Whole-workspace sweep green.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Verify: `git status` clean, last two commit subjects begin with `refactor(bus):` (Task 1.0) and `feat(phase-2a):` (this commit).

---

## Chunk 2: Per-clone fan-out + CLI surface

**Goal of this chunk:** A user can run `manta cast forking-realities --clones 3 --tasks plan.yaml` (or `--tasks plan.json`), and each clone receives its own task / scope / approach hint / budget overlay from that file. The cumulative-budget gate becomes Σ-of-per-clone-caps so asymmetric overrides still get enforced. The priming preamble exposes `{APPROACH_HINT_BLOCK}` (substituted with an "Approach hint: …" line, or with the empty string when no hint — no dangling label). `forking-realities` is allowlisted on `SUPPORTED_MODES` so the mode-rejection branch lets it through. After Chunk 2, the spawn surface is feature-complete for forking-realities; everything that follows (Phase 2b/2c/2d) reads the artifacts Chunk 1+2 produce.

**Files (new):**
- Create: `packages/manta-cli/src/spawner/tasks-file.ts` — pure parser: file path → `Record<CloneId, CloneAssignment>` or `CliError`.
- Create: `packages/manta-cli/tests/spawner/tasks-file.test.ts` — parser unit tests (YAML happy path, JSON happy path, missing file, invalid schema, duplicate clone_ids).
- Create: `packages/manta-cli/tests/integration/forking-spawn.test.ts` — end-to-end with the existing `fakeCloneRunner` + 2 clones with distinct assignments.
- Create: `docs/user/forking-realities.md` — short operator-facing intro to the mode (when to use, expected output, link to `--tasks` schema).

**Files (modified):**
- Modify: `packages/manta-cli/package.json` — add `yaml` to `dependencies` (^2.6).
- Modify: `packages/manta-cli/src/commands/cast.ts:14` — `SUPPORTED_MODES` includes `'forking-realities'`.
- Modify: `packages/manta-cli/src/commands/cast.ts:18-25` — extend `CastScopeOptions` is unchanged (Phase 0d shape preserved); the per-clone overlay is in the new `CloneAssignment` re-export from `@manta/bus` schema (not a CLI-local copy).
- Modify: `packages/manta-cli/src/commands/cast.ts:27-46` — add `cloneAssignments?: Record<CloneId, CloneAssignment>` to `RunCastOptions`.
- Modify: `packages/manta-cli/src/commands/cast.ts:79-101` — cumulative-budget gate becomes `Σ effectiveBudget` instead of `N * cap`.
- Modify: `packages/manta-cli/src/commands/cast.ts:130-181` — overlay loop applies per-clone `task` / `approachHint` / `scope` / `budgetUsd` / `deadlineMs` from `cloneAssignments`; missing assignment → cast-level defaults; the cast manifest's `castRoster` now records the per-clone assignment.
- Modify: `packages/manta-cli/src/commands/cast.ts:295-314` — `toBusContract` already round-trips `approach_hint` correctly per the spawn-loop snapshot output; verified via the new test in Chunk 2 Task 2.7.
- Modify: `packages/manta-cli/src/spawner/snapshot-builder.ts:4-20` — `CloneSpawnRequest.approachHint?: string | null` is already there; verify a Chunk 2 task adds an `approachHint`-set integration test.
- Modify: `packages/manta-cli/src/spawner/priming.ts:3-24` — add the `{APPROACH_HINT_BLOCK}` placeholder to `PRIMING_TEMPLATE`; `buildPrimingText` substitutes the placeholder with `\nApproach hint: <value>\n` when present, otherwise with the empty string (no dangling "Approach hint:" label, no orphan blank line).
- Modify: `packages/manta-cli/src/bin/manta.ts:45-117` — add `--tasks <path>` flag; on cast-with-tasks rejection logic; YAML/JSON parsing and validation surface up as `CliError(invalid_input)`.
- Modify: `packages/manta-cli/tests/spawner/priming.test.ts` — assert hint substitution + clean removal-when-null.

### File size sanity check

`packages/manta-cli/src/commands/cast.ts` grows by ~80 LOC (overlay loop + asymmetric budget + cloneAssignments wiring); current 314, target ~395 — still focused on one orchestration concern. `packages/manta-cli/src/bin/manta.ts` grows by ~40 LOC (--tasks flag + mutually-exclusive validation + YAML parse error mapping); current 183, target ~225. `packages/manta-cli/src/spawner/priming.ts` grows by ~10 LOC; current 28, target ~40 — trivial. `tasks-file.ts` is a new ~60 LOC parser. None of these crosses unwieldy.

### Tasks

- [ ] **2.1: Allowlist `forking-realities` on SUPPORTED_MODES (failing test first)**

**File:** `packages/manta-cli/tests/commands/cast.test.ts` (this file exists from Phase 0d — append).

```ts
it('accepts forking-realities mode (Phase 2a)', async () => {
  // Build minimal RunCastOptions with mode: 'forking-realities', a fake runner,
  // and verify the mode-rejection branch does NOT fire. This test does NOT yet
  // need cloneAssignments; with no assignment the loop falls back to a single
  // shared task — same shape as recon-swarm.
  const result = await runCastCommand(rt, {
    mode: 'forking-realities',
    task: 'placeholder',
    cloneCount: 2,
    cycleIntervalMs: 100,
    tickBudgetMs: 5_000,
    castId: 'cast-test-fr-1',
    budgetUsdPerClone: 1,
    budgetUsdPerCast: 5,
    runner: fakeCloneRunner,
    reporter: noopReporter,
    verifyMcp: false,
  });
  expect(result.exitCode).toBe(0);
});
```

Run: `pnpm --filter @manta/cli test -- tests/commands/cast.test.ts`
Expected: this test fails with `mode "forking-realities" is not supported in Phase 0 (only recon-swarm)`.

- [ ] **2.2: Implement the allowlist edit**

**File:** `packages/manta-cli/src/commands/cast.ts:14`

Replace:

```ts
const SUPPORTED_MODES: ReadonlySet<Mode> = new Set<Mode>(['recon-swarm']);
```

with:

```ts
// Phase 2a: forking-realities joins recon-swarm. Spec Sec 2 #2; see
// docs/research/phase-2-codepath-map.md §1.1 for the per-mode capability
// table deferral note (Phase 4+).
const SUPPORTED_MODES: ReadonlySet<Mode> = new Set<Mode>([
  'recon-swarm',
  'forking-realities',
]);
```

Update the error message at lines 73-78 to reflect the allowlist:

```ts
throw new CliError(
  `mode "${opts.mode}" is not supported (allowed: ${[...SUPPORTED_MODES].join(', ')})`,
  { kind: 'invalid_input' },
);
```

Run: `pnpm --filter @manta/cli test -- tests/commands/cast.test.ts`
Expected: the new test green; existing `recon-swarm`-only tests still green; an existing test that asserted the old error message (if any) gets updated to match the new wording.

- [ ] **2.3: cloneAssignments overlay — failing test first**

**File:** `packages/manta-cli/tests/commands/cast.test.ts` — append.

```ts
it('overlays per-clone task / scope / approachHint from cloneAssignments', async () => {
  const captured: Snapshot[] = [];
  const recordingRunner: CloneRunner = {
    run(input) {
      // Read the snapshot file the spawner just wrote and capture it.
      // (Real fakeCloneRunner already does this; if not, switch to a custom
      // spy. The point is to assert the snapshot's taskContract reflects the
      // per-clone overlay.)
      const snap = JSON.parse(readFileSync(input.env.MANTA_SNAPSHOT_PATH!, 'utf-8'));
      captured.push(snap);
      return fakeCloneRunner.run(input);
    },
  };
  await runCastCommand(rt, {
    mode: 'forking-realities',
    task: 'cast-default task',
    cloneCount: 2,
    cycleIntervalMs: 100,
    tickBudgetMs: 5_000,
    castId: 'cast-test-overlay-1',
    budgetUsdPerClone: 1,
    budgetUsdPerCast: 5,
    cloneAssignments: {
      A: { task: 'rewrite the SQL', approach_hint: 'use an index' },
      B: { task: 'rewrite the SQL', approach_hint: 'denormalize the table', budget_usd: 2 },
    },
    runner: recordingRunner,
    reporter: noopReporter,
    verifyMcp: false,
  });
  const a = captured.find((s) => s.taskContract.cloneId === 'A')!;
  const b = captured.find((s) => s.taskContract.cloneId === 'B')!;
  expect(a.taskContract.task).toBe('rewrite the SQL');
  expect(a.taskContract.approachHint).toBe('use an index');
  expect(b.taskContract.approachHint).toBe('denormalize the table');
  expect(b.budget.dollarsTotal).toBe(2); // per-clone override
});

it('cumulative budget gate sums per-clone budgets, not N×cap', async () => {
  // Two clones at $4 each = $8 total; cap = $7 → must reject.
  await expect(
    runCastCommand(rt, {
      mode: 'forking-realities',
      task: 'x',
      cloneCount: 2,
      cycleIntervalMs: 100,
      tickBudgetMs: 5_000,
      castId: 'cast-test-asym-1',
      budgetUsdPerClone: 1, // cast-level default
      budgetUsdPerCast: 7,
      cloneAssignments: {
        A: { task: 'a', budget_usd: 4 },
        B: { task: 'b', budget_usd: 4 },
      },
      runner: fakeCloneRunner,
      reporter: noopReporter,
      verifyMcp: false,
    }),
  ).rejects.toMatchObject({
    kind: 'invalid_input',
    message: expect.stringMatching(/cumulative budget.*\$8.*exceeds.*\$7/),
  });
});

it('falls back to cast-level defaults when an assignment is missing for a clone', async () => {
  const captured: Snapshot[] = [];
  const recordingRunner: CloneRunner = {
    run(input) {
      const snap = JSON.parse(readFileSync(input.env.MANTA_SNAPSHOT_PATH!, 'utf-8'));
      captured.push(snap);
      return fakeCloneRunner.run(input);
    },
  };
  await runCastCommand(rt, {
    mode: 'forking-realities',
    task: 'cast-level fallback task',
    cloneCount: 3,
    cycleIntervalMs: 100,
    tickBudgetMs: 5_000,
    castId: 'cast-test-fallback-1',
    budgetUsdPerClone: 1,
    budgetUsdPerCast: 5,
    cloneAssignments: {
      A: { task: 'A-only override' }, // B and C have no entry → inherit
    },
    runner: recordingRunner,
    reporter: noopReporter,
    verifyMcp: false,
  });
  const a = captured.find((s) => s.taskContract.cloneId === 'A')!;
  const b = captured.find((s) => s.taskContract.cloneId === 'B')!;
  const c = captured.find((s) => s.taskContract.cloneId === 'C')!;
  expect(a.taskContract.task).toBe('A-only override');
  expect(b.taskContract.task).toBe('cast-level fallback task');
  expect(c.taskContract.task).toBe('cast-level fallback task');
  // Approach hints default to null when no per-clone override.
  expect(a.taskContract.approachHint).toBeNull();
  expect(b.taskContract.approachHint).toBeNull();
  expect(c.taskContract.approachHint).toBeNull();
});

it('rejects an assignment key that is not a member of the spawn roster (typo guard)', async () => {
  await expect(
    runCastCommand(rt, {
      mode: 'forking-realities',
      task: 'x',
      cloneCount: 2, // roster is [A, B]
      cycleIntervalMs: 100,
      tickBudgetMs: 5_000,
      castId: 'cast-test-typo-1',
      budgetUsdPerClone: 1,
      budgetUsdPerCast: 5,
      cloneAssignments: {
        A: { task: 'a' },
        Z: { task: 'typo — Z is not in roster' },
      },
      runner: fakeCloneRunner,
      reporter: noopReporter,
      verifyMcp: false,
    }),
  ).rejects.toMatchObject({
    kind: 'invalid_input',
    message: expect.stringContaining('Z'),
  });
});
```

Run: `pnpm --filter @manta/cli test -- tests/commands/cast.test.ts`
Expected: all three new cases fail (cloneAssignments not yet wired; the asymmetric budget gate still uses N×cap so the second test fails differently than expected).

- [ ] **2.4: Implement the overlay loop + asymmetric budget gate**

**File:** `packages/manta-cli/src/commands/cast.ts`

Add to `RunCastOptions` (lines 27-46):

```ts
import type { CloneAssignment, CastPolicy } from '@manta/bus';

// ...

/**
 * Per-clone task / approach / scope / budget overlay. Keys are clone_id strings
 * (must be a subset of the spawn roster — keys for clones not in the roster
 * cause invalid_input). Values override the cast-level defaults for that clone
 * only; missing fields fall back to cast-level. Optional — if omitted, every
 * clone receives the cast-level defaults.
 */
cloneAssignments?: Record<string, CloneAssignment>;
```

**Restructure the function body** so per-clone values are computed *before* the cumulative-budget gate. Concretely, **move** the existing `const cloneIds = CLONE_NAMES.slice(0, opts.cloneCount);` line — currently at L126, just above the spawn `try { for (...) ... }` block — up to immediately after the `cloneCount` integer/range gate (currently L88). **Delete the original assignment at L126** (single source of truth — do not duplicate). Then insert the assignment-validation, effective-overlay computation, and asymmetric budget gate where the old `totalBudgetUsd = cloneCount * budgetUsdPerClone` block lives (L93-101). The reordered shape:

```ts
// (after lines 73-88: mode + cloneCount validation)

const cloneIds = CLONE_NAMES.slice(0, opts.cloneCount);
const assignments = opts.cloneAssignments ?? {};

// Reject any assignment key not in the roster — operator typo guard.
for (const id of Object.keys(assignments)) {
  if (!cloneIds.includes(id)) {
    throw new CliError(
      `cloneAssignments key "${id}" is not a member of the spawn roster (${cloneIds.join(', ')})`,
      { kind: 'invalid_input' },
    );
  }
}

const effective: Record<string, {
  task: string;
  approachHint: string | null;
  scope: CastScopeOptions;
  budgetUsd: number;
  deadlineMs: number;
}> = {};
let totalBudgetUsd = 0;
for (const id of cloneIds) {
  const a = assignments[id] ?? {};
  const e = {
    task: a.task ?? opts.task,
    approachHint: a.approach_hint ?? null,
    scope: a.scope
      ? {
          allowedPaths: a.scope.allowed_paths,
          forbiddenPaths: a.scope.forbidden_paths,
          maxFilesChanged: a.scope.max_files_changed,
        }
      : (opts.scope ?? DEFAULT_SCOPE),
    budgetUsd: a.budget_usd ?? opts.budgetUsdPerClone,
    deadlineMs: a.deadline_seconds != null ? a.deadline_seconds * 1_000 : DEFAULT_DEADLINE_MS,
  };
  effective[id] = e;
  totalBudgetUsd += e.budgetUsd;
}

if (totalBudgetUsd > opts.budgetUsdPerCast) {
  const detail = cloneIds.map((id) => `${id}=$${effective[id]!.budgetUsd}`).join(' + ');
  throw new CliError(
    `cumulative budget (${detail} = $${totalBudgetUsd}) exceeds --budget-per-cast-usd=$${opts.budgetUsdPerCast}. ` +
      `Reduce per-clone budgets, lower --budget-per-clone-usd, or raise --budget-per-cast-usd.`,
    { kind: 'invalid_input' },
  );
}
```

**Note on units:** `e.deadlineMs` stays in milliseconds — same unit as `DEFAULT_DEADLINE_MS = 1_200_000` (cast.ts:16). The snapshot's `taskContract.deadlineSeconds` is in seconds; the conversion happens inside `buildCloneSnapshot` (see `packages/manta-cli/src/spawner/snapshot-builder.ts:28` — `Math.max(1, Math.ceil(req.deadlineMs / 1000))`). The CLI never deals with `deadlineSeconds` directly. The new code path reads `assignment.deadline_seconds` (CloneAssignmentSchema uses seconds), multiplies by 1_000 once at overlay time, and hands ms to `buildCloneSnapshot` — single conversion point, same as before.

Then in the spawn loop, replace the unconditional `task: opts.task` / `scope: opts.scope ?? DEFAULT_SCOPE` / `budgetUsd: opts.budgetUsdPerClone` / `deadlineMs: DEFAULT_DEADLINE_MS` (current lines 138-161) with reads from `effective[cloneId]`:

```ts
const e = effective[cloneId]!;
const snap = buildCloneSnapshot({
  cloneId,
  mode: opts.mode,
  task: e.task,
  scope: {
    allowedPaths: e.scope.allowedPaths,
    forbiddenPaths: e.scope.forbiddenPaths,
    maxFilesChanged: e.scope.maxFilesChanged,
  },
  approachHint: e.approachHint,
  siblingClones: cloneIds.filter((id) => id !== cloneId),
  deadlineMs: e.deadlineMs,
  parentWorktree: rt.repoRoot,
  cloneWorktree: wt.path,
  parentPid: process.pid,
  parentSessionId: opts.castId,
  castId: opts.castId,
  budgetUsd: e.budgetUsd,
});
```

**Replace** Chunk 1's stub `castPolicy = { peer_messaging: 'allowed', auto_merge_threshold: null }` and the stub `castRoster = cloneIds.map((id) => ({ clone_id: id, assignment: null }))` introduced in Chunk 1 Task 1.14 with the mode-aware versions:

```ts
const castPolicy: CastPolicy = opts.mode === 'forking-realities'
  ? { peer_messaging: 'denied', auto_merge_threshold: null }
  : { peer_messaging: 'allowed', auto_merge_threshold: null };

const castRoster = cloneIds.map((id) => ({
  clone_id: id,
  assignment: assignments[id] ?? null,
}));
```

These two values flow into `spawnClone({ ..., castMode, castPolicy, castRoster })` once. Every clone of the cast hands the same triple to `casts.create(...)`; the first call writes the manifest with the right policy + per-clone assignments, subsequent calls are idempotent. **Single manifest write per cast — no double-write conflict.** The Chunk-1 stub assignment of `{ peer_messaging: 'allowed', auto_merge_threshold: null }` only existed in the interim where Chunk 1 had landed but Chunk 2 had not; once Chunk 2 ships, the stub is gone in the same edit.

Run: `pnpm --filter @manta/cli test -- tests/commands/cast.test.ts`
Expected: every Phase 0d test plus the four new ones from Task 2.3 (allowlist + overlay + asymmetric budget + fallback + roster-typo) green.

- [ ] **2.5: priming.ts — `{APPROACH_HINT_BLOCK}` substitution (failing test first)**

**File:** `packages/manta-cli/tests/spawner/priming.test.ts`

```ts
it('expands {APPROACH_HINT_BLOCK} to "Approach hint: ..." when set', () => {
  const snap = makeSnapshot({ approachHint: 'use an index on orders.customer_id' });
  const text = buildPrimingText(snap);
  expect(text).toContain('Approach hint: use an index on orders.customer_id');
  expect(text).not.toContain('{APPROACH_HINT_BLOCK}');
});

it('removes the {APPROACH_HINT_BLOCK} placeholder entirely when approachHint is null', () => {
  const snap = makeSnapshot({ approachHint: null });
  const text = buildPrimingText(snap);
  expect(text).not.toContain('{APPROACH_HINT_BLOCK}');
  expect(text).not.toMatch(/Approach hint:\s*$/m); // no dangling label
  // No orphan blank line either — the substitution returns "" not "\n":
  expect(text).not.toMatch(/\n\n\nHeartbeat is implicit/);
});

it('substitutes hint independently per clone', () => {
  const a = buildPrimingText(makeSnapshot({ cloneId: 'A', approachHint: 'index' }));
  const b = buildPrimingText(makeSnapshot({ cloneId: 'B', approachHint: 'denormalize' }));
  expect(a).toContain('Approach hint: index');
  expect(b).toContain('Approach hint: denormalize');
  expect(a).not.toContain('denormalize');
});
```

(`makeSnapshot` is a small helper defined at the top of this test file — many Phase 0d tests have the same pattern; if `priming.test.ts` doesn't already have it, add it as a private helper that calls `captureState({...})` from `@manta/snapshot` with sensible defaults overridable per call.)

Run: `pnpm --filter @manta/cli test -- tests/spawner/priming.test.ts`
Expected: all three new tests fail because `{APPROACH_HINT_BLOCK}` is not yet a placeholder.

- [ ] **2.6: Implement priming hint substitution**

**File:** `packages/manta-cli/src/spawner/priming.ts`

Edit the `PRIMING_TEMPLATE` to add the placeholder block. The exact insertion point — after step 5 ("Begin the work...") and before "Heartbeat is implicit" — keeps the hint visible at the boundary between contract acknowledgment and execution:

```ts
const PRIMING_TEMPLATE = `\
You are a Manta clone (illusion of the main agent). Identity: clone_id={CLONE_ID}, cast_id={CAST_ID}, mode={MODE}.

Startup sequence — do these in order, before any tool that mutates files (Read, Edit, Write):
1. Use the Skill tool to load \`manta-as-clone\`.
2. Read your snapshot from the path in env var \`MANTA_SNAPSHOT_PATH\` (it is a JSON file containing taskContract, scope, siblingClones, deadline, plus reference state). The CLI spawner has already created your registry record on the Bus.
3. Call \`manta.heartbeat\` with { clone_id: "{CLONE_ID}", state: "WORKING" }. If it errors with \`not_found\`, abort — your spawner did not pre-register; do not try to self-register (Phase 0 design forbids it; see the manta-as-clone skill).
4. Call \`manta.task_contract.read\` with your clone_id and \`manta.ack_contract\` with a one-sentence interpretation of the contract.
5. Begin the work described in the user prompt below, staying inside taskContract.scope.allowedPaths and outside taskContract.scope.forbiddenPaths (which always includes \`.manta/state\` and \`secrets/\`).
{APPROACH_HINT_BLOCK}
Heartbeat is implicit (bus auto-touch). Every successful \`manta.*\` MCP call you make refreshes your last_heartbeat_at as a side effect — lock, claim, broadcast, zk_write, contract_ack, all of them. You do not need to call manta.heartbeat on a cadence; the orchestrator's heartbeatTimeoutMs (default 90 s) is measured against your last bus interaction of any kind. Reach for explicit manta.heartbeat only for state transitions (e.g. WORKING → BLOCKED) or to log a progress string into events.jsonl. (Bug #9 was originally addressed by a per-turn skill rule in v0.0.2 — validation cast cast-1778189501846 proved that didn't work, so the bus enforces it now; see manta-as-clone v0.0.3.)

When done — even on failure — invoke the \`manta-graceful-death\` skill and exit. Required shutdown ordering (skipping or reordering any step is drift): (a) write last-gasp-report.md to worktree root; (b) \`git add\` your deliverables + last-gasp-report.md and commit on the worktree branch with message \`manta-clone-{CLONE_ID}: <one-line summary>\` — never push, the main pulls; (c) at least one \`manta.zk_write\` call with one paragraph of the most surprising thing you learned, tagged \`["clone-{CLONE_ID}", "cast-{CAST_ID}"]\`; (d) \`manta.unlock\` / \`manta.release_work\` for held resources; (e) \`manta.suicide_intent\`; (f) \`manta.report_death\`. Do not print the final report directly; the post-mortem path is your output channel.

Forbidden in this phase: recursive \`/manta cast\`, edits outside scope, direct user contact, quiet writes to \`.manta/state/*\`.
`;

export function buildPrimingText(snapshot: Snapshot): string {
  const hint = snapshot.taskContract.approachHint;
  // The block is one paragraph + a leading blank line so it reads as its own
  // section. When there's no hint we drop the block entirely (no leftover
  // blank line, no dangling label).
  const approachBlock = hint != null && hint.length > 0
    ? `\nApproach hint: ${hint}\n`
    : '';
  return PRIMING_TEMPLATE
    .replaceAll('{CLONE_ID}', snapshot.taskContract.cloneId)
    .replaceAll('{CAST_ID}', snapshot.castId)
    .replaceAll('{MODE}', snapshot.taskContract.mode)
    .replaceAll('{APPROACH_HINT_BLOCK}', approachBlock);
}
```

Run: `pnpm --filter @manta/cli test -- tests/spawner/priming.test.ts`
Expected: every existing case stays green; the three new cases pass.

- [ ] **2.7: Pin the snapshot↔bus `approach_hint` translation drift (regression guard)**

**File:** `packages/manta-cli/tests/commands/cast.test.ts`

Per research §2.3 point 2, the snapshot uses `approachHint: z.string().nullable()` and the bus uses `approach_hint: z.string().max(8_000).optional()`. The translation at `cast.ts:295-314` (`toBusContract`) handles it — when `tc.approachHint === null`, the field is elided; otherwise it's set. Today this is correct but untested in isolation. Add:

```ts
import { TaskContractSchema as BusTaskContractSchema } from '@manta/bus';
import { toBusContract } from '../../src/commands/cast'; // export it (currently file-private)

it('toBusContract elides approach_hint when snapshot.approachHint is null', () => {
  const snap = makeSnapshot({ approachHint: null });
  const bus = toBusContract(snap);
  expect(BusTaskContractSchema.parse(bus)).toBeDefined(); // round-trips through bus zod
  expect((bus as any).approach_hint).toBeUndefined();
});

it('toBusContract sets approach_hint when snapshot.approachHint is non-null', () => {
  const snap = makeSnapshot({ approachHint: 'use an index' });
  const bus = toBusContract(snap);
  expect((bus as any).approach_hint).toBe('use an index');
});

it('toBusContract round-trips a non-null approachHint through bus zod', () => {
  const snap = makeSnapshot({ approachHint: 'denormalize' });
  const bus = BusTaskContractSchema.parse(toBusContract(snap));
  expect(bus.approach_hint).toBe('denormalize');
});
```

To make this work, export `toBusContract` from `cast.ts` (currently file-private function at line 295) with an explicit `@internal` JSDoc:

```ts
/**
 * @internal — exported for contract-drift tests in tests/commands/cast.test.ts.
 * Not part of the public CLI surface; do not import from outside this package.
 */
export function toBusContract(snap: Snapshot): BusTaskContract { /* ... */ }
```

Run: `pnpm --filter @manta/cli test`
Expected: every test green.

- [ ] **2.8: tasks-file.ts parser + tests**

**File (new):** `packages/manta-cli/tests/spawner/tasks-file.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTasksFile } from '../../src/spawner/tasks-file';

describe('parseTasksFile', () => {
  it('parses a YAML file with two clones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'manta-tf-'));
    try {
      const f = join(dir, 'plan.yaml');
      writeFileSync(f, `
A:
  task: rewrite SQL
  approach_hint: use index
B:
  task: rewrite SQL
  approach_hint: denormalize
  budget_usd: 4
`);
      const out = parseTasksFile(f);
      expect(out.A.task).toBe('rewrite SQL');
      expect(out.A.approach_hint).toBe('use index');
      expect(out.B.budget_usd).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses a JSON file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'manta-tf-'));
    try {
      const f = join(dir, 'plan.json');
      writeFileSync(
        f,
        JSON.stringify({ A: { task: 'a' }, B: { task: 'b', budget_usd: 2 } }),
      );
      const out = parseTasksFile(f);
      expect(out.A.task).toBe('a');
      expect(out.B.budget_usd).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws CliError(invalid_input) on missing file', () => {
    expect(() => parseTasksFile('/nope/nope.yaml')).toThrow(/invalid_input/);
  });

  it('throws CliError(invalid_input) on schema-invalid content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'manta-tf-'));
    try {
      const f = join(dir, 'plan.yaml');
      writeFileSync(f, 'A:\n  task: ""\n'); // empty task — rejected by schema
      expect(() => parseTasksFile(f)).toThrow(/invalid_input/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws on an unknown extension', () => {
    const dir = mkdtempSync(join(tmpdir(), 'manta-tf-'));
    try {
      const f = join(dir, 'plan.txt');
      writeFileSync(f, 'A:\n  task: x\n');
      expect(() => parseTasksFile(f)).toThrow(/invalid_input/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an empty assignments object', () => {
    const dir = mkdtempSync(join(tmpdir(), 'manta-tf-'));
    try {
      const f = join(dir, 'plan.json');
      writeFileSync(f, JSON.stringify({}));
      expect(() => parseTasksFile(f)).toThrow(/invalid_input/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects partial scope (all-or-nothing — bus ScopeSchema is .strict())', () => {
    const dir = mkdtempSync(join(tmpdir(), 'manta-tf-'));
    try {
      const f = join(dir, 'plan.yaml');
      writeFileSync(f, `
A:
  task: x
  scope:
    allowed_paths: [db/]
`);
      // Missing forbidden_paths + max_files_changed → ScopeSchema rejects.
      expect(() => parseTasksFile(f)).toThrow(/invalid_input/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves clone_id case sensitivity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'manta-tf-'));
    try {
      const f = join(dir, 'plan.json');
      writeFileSync(f, JSON.stringify({ a: { task: 'lower' }, A: { task: 'upper' } }));
      const out = parseTasksFile(f);
      expect(out.a.task).toBe('lower');
      expect(out.A.task).toBe('upper');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

Run: `pnpm --filter @manta/cli test -- tests/spawner/tasks-file.test.ts`
Expected: all tests fail because `tasks-file.ts` does not exist.

- [ ] **2.9: Implement `tasks-file.ts`**

**File (new):** `packages/manta-cli/src/spawner/tasks-file.ts`

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { CloneAssignmentSchema, type CloneAssignment } from '@manta/bus';
import { CliError } from '../errors.js';

const FileSchema = z
  .record(z.string().min(1), CloneAssignmentSchema)
  .refine((rec) => Object.keys(rec).length >= 1, {
    message: 'tasks file must contain at least one clone assignment',
  });

/**
 * Parse a tasks file into a `Record<clone_id, CloneAssignment>`. Supports
 * `.yaml` / `.yml` / `.json`. Other extensions raise `invalid_input`. Schema
 * mismatches surface the zod error message verbatim wrapped in `invalid_input`
 * so CLI output stays grep-able.
 */
export function parseTasksFile(file: string): Record<string, CloneAssignment> {
  const ext = path.extname(file).toLowerCase();
  if (!['.yaml', '.yml', '.json'].includes(ext)) {
    throw new CliError(
      `--tasks file must end in .yaml/.yml/.json (got "${ext || '<no extension>'}")`,
      { kind: 'invalid_input' },
    );
  }
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (cause) {
    throw new CliError(`--tasks: cannot read file ${file}`, {
      kind: 'invalid_input',
      cause,
    });
  }
  let parsed: unknown;
  try {
    parsed = ext === '.json' ? JSON.parse(raw) : parseYaml(raw);
  } catch (cause) {
    throw new CliError(`--tasks: parse error in ${file}`, {
      kind: 'invalid_input',
      cause,
    });
  }
  const result = FileSchema.safeParse(parsed);
  if (!result.success) {
    throw new CliError(
      `--tasks: schema mismatch in ${file}: ${result.error.issues.map((i) => i.message).join('; ')}`,
      { kind: 'invalid_input', cause: result.error },
    );
  }
  return result.data;
}
```

Add the dependency via `pnpm add yaml@^2.6 --filter @manta/cli` (run from the workspace root). This updates both `packages/manta-cli/package.json` and `pnpm-lock.yaml` in one step. The chunk's commit (Task 2.15) stages both files. `^2.6` is consistent with the repo's other `^`-pinned deps.

Run: `pnpm --filter @manta/cli test -- tests/spawner/tasks-file.test.ts`
Expected: all tests green; coverage ≥ 80% on the new file.

- [ ] **2.10: bin/manta.ts — wire the `--tasks` flag**

**Semantics decision (sticky):** `--task` and `--tasks` are **complementary**, not mutually exclusive. `--task` is the cast-level default; `--tasks` is the per-clone overlay. A clone with no entry in `--tasks` inherits `--task`'s value via the overlay fallback in `cast.ts` (`a.task ?? opts.task`). This avoids the brittle "explicit `--task unspecified` vs default `'unspecified'`" detection problem and matches Task 2.3 case 3's "fallback to cast-level defaults" expectation.

**File:** `packages/manta-cli/src/bin/manta.ts`

In the inline destructuring type literal at L76-86 add `tasks?: string;` (optional — flag has no default; commander leaves the property `undefined` when the flag is absent):

```diff
        options: {
          clones: string;
          task: string;
+         tasks?: string;
          cycleIntervalMs: string;
          // ...
        },
```

In the `program.command('cast <mode>')` block (L45-117) add `.option(...)`:

```ts
.option(
  '--tasks <path>',
  'path to a YAML/JSON file with per-clone task overlays. Combines with --task: clones present in the file use the file\'s entry; clones absent fall back to --task. See docs/user/forking-realities.md for the schema.',
)
```

Add imports at the top of `bin/manta.ts`:

```ts
import { parseTasksFile } from '../spawner/tasks-file.js';
import type { CloneAssignment } from '@manta/bus';
```

In the action handler, after the CSV-split helpers and before `await runWithRuntime(...)`:

```ts
const cloneAssignments: Record<string, CloneAssignment> | undefined =
  options.tasks != null ? parseTasksFile(options.tasks) : undefined;
```

(`parseTasksFile` itself throws `CliError(invalid_input)` on parse/schema/io failures — they bubble through `main()`'s `isCliError` branch (L156-166). No additional handling needed here.)

Pass `cloneAssignments` into `runCastCommand`:

```ts
await runWithRuntime((rt) =>
  runCastCommand(rt, {
    mode: mode as unknown as Mode,
    task: options.task,
    cloneCount: parseInt(options.clones, 10),
    cycleIntervalMs: parseInt(options.cycleIntervalMs, 10),
    tickBudgetMs: parseInt(options.tickBudgetMs, 10),
    budgetUsdPerClone: parseFloat(options.budgetPerCloneUsd),
    budgetUsdPerCast: parseFloat(options.budgetPerCastUsd),
    scope: {
      allowedPaths: splitCsv(options.allowedPaths),
      forbiddenPaths: splitCsv(options.forbiddenPaths),
      maxFilesChanged: parseInt(options.maxFilesChanged, 10),
    },
    cloneAssignments,
    castId: `cast-${Date.now()}`,
    runner: runClaudeCli(),
    reporter,
  }),
);
```

Add a small integration check at `packages/manta-cli/tests/commands/cast.test.ts` (extend, not new file) — write a tiny YAML in a tmp dir, parse it with `parseTasksFile`, hand the result to `runCastCommand` directly with `verifyMcp: false`, assert each clone's snapshot reflects the overlay. This is the parse-to-runtime seam; Task 2.3 covers the runtime-with-injected-assignments seam in isolation.

```ts
it('parses --tasks YAML at the CLI seam and applies it through runCastCommand', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'manta-cli-tasks-'));
  try {
    const f = join(dir, 'plan.yaml');
    writeFileSync(f, `A:\n  task: A-from-yaml\nB:\n  task: B-from-yaml\n`);
    const cloneAssignments = parseTasksFile(f);
    // ... build rt + recordingRunner identical to Task 2.3 ...
    const result = await runCastCommand(rt, {
      mode: 'forking-realities',
      task: 'cast-default-ignored',
      cloneCount: 2,
      cycleIntervalMs: 100,
      tickBudgetMs: 5_000,
      castId: 'cast-cli-yaml-1',
      budgetUsdPerClone: 1,
      budgetUsdPerCast: 5,
      cloneAssignments,
      runner: recordingRunner,
      reporter: noopReporter,
      verifyMcp: false,
    });
    expect(result.exitCode).toBe(0);
    expect(captured.find((s) => s.taskContract.cloneId === 'A')!.taskContract.task).toBe('A-from-yaml');
    expect(captured.find((s) => s.taskContract.cloneId === 'B')!.taskContract.task).toBe('B-from-yaml');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

Run: `pnpm --filter @manta/cli test`
Expected: every test green.

- [ ] **2.11: End-to-end smoke test — forking-realities cast with two assignments**

**File (new):** `packages/manta-cli/tests/integration/forking-spawn.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCastCommand } from '../../src/commands/cast';
import { runFakeCloneScript } from '../../src/spawner/clone-spawner';
import { createRuntime } from '../../src/runtime';
import { fileURLToPath } from 'node:url';

const FAKE_CLONE = fileURLToPath(new URL('../fixtures/fake-clone.mjs', import.meta.url));

describe('forking-realities spawn integration', () => {
  it('spawns 2 clones with distinct assignments; manifest exists; metadata.cast_mode set', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'manta-fr-int-'));
    try {
      // Make `repo` a git repo so the spawner's worktree-add step works.
      // (Phase 0d testing pattern — copy the existing helper from the cast.test fixture.)
      // ... initialise git repo ...
      const rt = await createRuntime({ repoRoot: repo });
      try {
        const result = await runCastCommand(rt, {
          mode: 'forking-realities',
          task: 'irrelevant — overridden per-clone',
          cloneCount: 2,
          cycleIntervalMs: 100,
          tickBudgetMs: 30_000,
          castId: 'cast-int-fr-1',
          budgetUsdPerClone: 1,
          budgetUsdPerCast: 5,
          cloneAssignments: {
            A: { task: 'algorithm-only' },
            B: { task: 'index-based', approach_hint: 'orders.customer_id' },
          },
          runner: runFakeCloneScript({ scriptPath: FAKE_CLONE }),
          reporter: { info: () => {}, warn: () => {}, error: () => {} },
          verifyMcp: false,
        });
        expect(result.exitCode).toBe(0);

        // 1. Cast manifest exists with both clones + forking-realities policy.
        const manifestPath = join(repo, '.manta/state/casts/cast-int-fr-1.json');
        expect(existsSync(manifestPath)).toBe(true);
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        expect(manifest.mode).toBe('forking-realities');
        expect(manifest.policy.peer_messaging).toBe('denied');
        expect(manifest.clones.map((c: { clone_id: string }) => c.clone_id).sort()).toEqual(['A', 'B']);

        // 2. Each clone's registry record carries cast_mode.
        const all = await rt.ctx.registry.list();
        for (const c of all) {
          expect(c.metadata.cast_mode).toBe('forking-realities');
          expect(c.metadata.cast_id).toBe('cast-int-fr-1');
        }

        // 3. Each clone's contract reflects its assignment.
        // ContractsStore.read returns a StoredContract<{ contract: TaskContract, ... }>;
        // see packages/manta-bus/src/state/contracts.ts:42-46. The bus-side
        // TaskContract is snake_case (schema.ts:67-77) so `approach_hint` is
        // the field name on the wire.
        const aStored = await rt.ctx.contracts.read('A');
        const bStored = await rt.ctx.contracts.read('B');
        expect(aStored.contract.task).toBe('algorithm-only');
        expect(bStored.contract.task).toBe('index-based');
        expect(bStored.contract.approach_hint).toBe('orders.customer_id');
      } finally {
        await rt.dispose();
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
```

Note: the `fake-clone.mjs` fixture from Phase 0d already exits cleanly without doing meaningful work. This test asserts the *spawn-side* artifacts (manifest, registry metadata, contracts), not the clone's own behaviour — that's Phase 2c/2d territory.

Run: `pnpm --filter @manta/cli test -- tests/integration/forking-spawn.test.ts`
Expected: green.

- [ ] **2.12: Operator-facing doc — `forking-realities` mode + tasks-file schema**

**File (new):** `docs/user/forking-realities.md`

Short — about 80 lines — covering: when to use the mode, the `--tasks <file>` schema (with a worked example using both YAML and JSON), the spawn-side observable artifacts (cast manifest path, per-clone branches), the new `yaml@^2.6` dependency (operators on lockdown environments need to allowlist it), and a forward-pointer to Phase 2c (`/manta promote <id>`) for the merge-review step that doesn't exist yet.

**Critical wording constraints (do not violate):**
- Do **NOT** claim sibling clones are "isolated", "sandboxed", or "cannot communicate". The bus filter ships in Phase 2b; until then, `manta.message` between siblings is technically reachable on the bus surface (the existing `recon-swarm` policy stays in effect for 2a-shipped forking-realities casts).
- Do **NOT** call merge-review "automated", "scored", or "ranked" — those land in Phase 2c.
- Use language like "merge-review is manual until Phase 2c lands — the operator inspects each `manta/<castId>/<cloneId>` branch via plain `git diff` / `git log` and merges the chosen one with `git merge`".
- Use language like "sibling messaging policy is *recorded* on the cast manifest but *not yet enforced* — Phase 2b enforces".
- Link to `docs/user/cast-manifest.md` (created in Chunk 1 Task 1.18) instead of duplicating manifest schema.

- [ ] **2.13: README + CHANGELOG bump**

**File:** top-level `README.md` — update the 8-phase status table to mark Phase 2a as **In progress** (or **Spawn shipped** depending on the wording convention used in earlier phases — `git log -- README.md` to confirm).

**File:** top-level `CHANGELOG.md` — add a `0.2.0` (or per current version convention) entry under "Unreleased":

```
### Added
- forking-realities mode allowlist (Phase 2a — spawn surface only; bus isolation is Phase 2b, merge-review is Phase 2c)
- Cast manifest at .manta/state/casts/<castId>.json (mode + roster + policy; idempotent across clones)
- registry.metadata.cast_mode (Phase 2b filter join key)
- Per-clone task overlay via --tasks <yaml|json> (manta cast); --task remains the cast-level fallback
- Asymmetric per-clone budgets (cumulative gate switches from N×cap to Σ(per-clone caps))
- {APPROACH_HINT_BLOCK} placeholder in the priming preamble (substitutes "Approach hint: …" or empty)
- New runtime dep: yaml@^2.6 (for --tasks parsing)
```

- [ ] **2.14: Whole-workspace sweep + lint**

Run:
```bash
pnpm -r build && pnpm -r test && pnpm -r lint
```

Expected: every project green; no lint warnings; coverage thresholds met. Capture the test count (from vitest output) for the commit message.

- [ ] **2.15: Commit Chunk 2**

```bash
git add packages/manta-cli/src/commands/cast.ts \
        packages/manta-cli/src/bin/manta.ts \
        packages/manta-cli/src/spawner/priming.ts \
        packages/manta-cli/src/spawner/tasks-file.ts \
        packages/manta-cli/src/spawner/clone-spawner.ts \
        packages/manta-cli/package.json \
        packages/manta-cli/tests/commands/cast.test.ts \
        packages/manta-cli/tests/spawner/priming.test.ts \
        packages/manta-cli/tests/spawner/tasks-file.test.ts \
        packages/manta-cli/tests/integration/forking-spawn.test.ts \
        docs/user/forking-realities.md \
        README.md \
        CHANGELOG.md \
        pnpm-lock.yaml

# CLAUDE.md HARD RULE: take author from a single `git log -1 --format='%ae %an'`.
# CLAUDE.md HARD RULE: take author from `git log`. Two separate calls —
# author names with spaces ("Tim Hunt") would break ${VAR% *} parsing of
# a combined "%ae %an" string.
EMAIL="$(git log -1 --format='%ae')"
NAME="$(git log -1 --format='%an')"
git -c user.email="$EMAIL" -c user.name="$NAME" commit -m "$(cat <<'EOF'
feat(phase-2a): forking-realities spawn surface + per-clone task overlay

Allowlist forking-realities on SUPPORTED_MODES; add --tasks <yaml|json> for
per-clone task / approach_hint / scope / budget / deadline overlays; switch
the cumulative-budget gate to Σ-of-per-clone-caps so asymmetric overrides
are honoured; expose {APPROACH_HINT_BLOCK} in the priming preamble (or
remove it cleanly when null); spawner records the per-clone assignment in
the cast manifest's `clones[].assignment` field and tags every registry
record with metadata.cast_mode.

Tests: cast.test.ts (allowlist + overlay + asymmetric budget + roster typo
guard + toBusContract drift), priming.test.ts (hint substitution + clean
null path), tasks-file.test.ts (YAML/JSON happy + missing/invalid/empty),
forking-spawn integration (cast manifest + metadata.cast_mode + per-clone
contracts). Whole-workspace sweep green.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Verify: `git status` clean; `git log --oneline -5` shows both Phase 2a chunks landed.

---

## Acceptance criteria (Phase 2a-level — feeds INDEX.md)

- `manta cast forking-realities --clones 2 --tasks plan.yaml` succeeds with two distinct contracts on disk and a manifest at `.manta/state/casts/<castId>.json`.
- `manta cast recon-swarm --clones 2 --task 'x'` (no behaviour change for the existing mode) writes a manifest with `policy.peer_messaging = 'allowed'` and `clones[].assignment = null` for every clone.
- `Registry.list()` after either cast returns `metadata.cast_id` AND `metadata.cast_mode` populated for every clone.
- The asymmetric cumulative-budget gate rejects `--budget-per-cast-usd $7` when two clones at $4 each (post-overlay) total $8.
- Coverage ≥ 80 % on `state/casts.ts`, `tasks-file.ts`, and the schema additions; whole-workspace sweep green.
- `--tasks` and `--task` are mutually exclusive (either yields a clear `invalid_input` error message).
- Plan reviewer subagent approved both chunks before they executed.
- Operator-facing docs (`docs/user/forking-realities.md`, README, CHANGELOG) reflect the shipped behaviour without promising un-shipped Phase 2b/2c/2d capabilities.

What this plan **does not** ship — and the next sub-plan that does:
- Sibling-message rejection / bus filter → Phase 2b.
- runMergeReview / `/manta promote` / composite scoring → Phase 2c.
- `tail` / `replay` / `audit` / `inspect` commands → Phase 2d.
- Charge-system hooks for forking-realities (cost = 2 charges per spec Sec 6.4) → Phase 3.

---

## Risks called out for the reviewer

1. **Cast manifest as cross-phase contract.** Multiple Phase 2 sub-plans read this file (2b filter, 2c orchestrator, 2d tail). If the schema changes after 2a ships, every reader needs the same migration. Mitigation: `version: 1` is explicit on the manifest; any future change must bump it and `CastsStore.read` must reject unknown versions instead of silently degrading. This invariant is in `CastManifestSchema` (zod `.literal(1)`) and surfaced loudly via `BusNotFoundError` rather than fallback.
2. **Snapshot/bus `approach_hint` drift.** Snapshot uses `nullable()`, bus uses `.optional()`. The `toBusContract` translation works today but is one rename away from breaking. Task 2.7's regression test pins the round-trip; do not skip that test.
3. **`yaml` dependency.** New runtime dep — small, well-trusted, MIT — but it's the only non-zod parser the CLI grows. Operators on lockdown environments will need to allowlist it. Mention in `forking-realities.md` so the introduction doesn't surprise.
4. **Cast manifest size.** Per spec Sec 6.4 `forking-realities` N ≤ 3, so manifests are bounded ≤ ~3 KB. No streaming reader needed; `atomicReadJson` is the right choice. If Phase 7+ ever raises N to 10+, revisit.
5. **`forking-realities` allowlisted before bus filter ships.** Between Phase 2a and 2b, a `forking-realities` cast can theoretically have siblings exchange `manta.message` — same surface as `recon-swarm`. This is acceptable risk because Phase 2b ships in the same milestone and no production user runs `forking-realities` until Phase 2c (merge-review) lands. Document the "Phase 2a ≠ production-ready forking-realities" caveat in `docs/user/forking-realities.md` explicitly.
6. **CastsStore.create idempotency race.** Two clones spawning concurrently may both call `casts.create`. The atomic-mutex in `atomicMutateJson` serialises them; the second sees the first's write and the idempotency check returns the existing manifest unchanged. Test 1.16 second case pins this; do not weaken it.
