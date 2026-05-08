# Phase 2b — Bus Isolation (Plagiarism Prevention) Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Production-grade enforcement of spec Sec 5.8 plagiarism prevention. After this plan ships, sibling clones in a `forking-realities` cast cannot exfiltrate work-in-progress information through the Bus: `manta.message` between siblings is rejected with a typed error, `manta.broadcast` events are stamped with `cast_id` + `cast_mode` so future Tier-3 `tail` (Phase 2d) consumers can filter sibling visibility, `manta.claim_work` is rejected for forking-realities clones (work-claim is conceptually a no-op when each sibling does the same job in isolation), and `manta.task_contract.read` rejects cross-clone reads. Every enforcement point has both a Bus-side hard rejection (Strategy 1 — closed loud) AND a skill-side soft prior (Strategy 2 — explainable, stops honest clones at the source). Belt-and-braces by design.

**Architecture:** Two chunks. Chunk 1 lands Strategy 1 — schema invariant tightening (`metadata.cast_id` required when `mode === 'forking-realities'`), the new `BusForkingIsolationError` class with `serializeError` envelope mapping, a small `siblingsInSameForkingCast` helper module, and the `message` / `broadcast` / `task_contract.read` / `claim_work` handler edits in `packages/manta-bus/src/tools/`. Chunk 2 lands Strategy 2 — `MANTA_BUS_PEER_SCOPE` env injection by the spawner, `manta-as-clone` v0.0.3 forking-realities bullet, the `manta-coordinate` v0.0.2 contract-refresh discipline note (main-side), and an end-to-end integration test that spawns 2 fake forking-realities clones and asserts every isolation boundary holds.

**Tech Stack:** TypeScript 5.x strict, Node 20+, `zod`, `vitest`. Zero new runtime dependencies — every change is on top of primitives shipped in Phase 0/1/2a.

---

## Why two chunks (and not one, and not three)

The Strategy 1 enforcement points (bus-side) and Strategy 2 reinforcement (skill + env) target different failure modes — Strategy 1 catches buggy clones loud, Strategy 2 catches honest clones early. They depend on each other for the "belt-and-braces" guarantee but they ship independently:

- **Chunk 1** is pure bus-side hard enforcement: any forking-realities register that omits `metadata.cast_id` is rejected at parse time (schema refine + 1 test); any sibling-to-sibling `manta.message` in such a cast is rejected at the handler with a typed error (filter helper + 2 tests); any forking-realities sibling calling `manta.task_contract.read` for a different clone_id is rejected (3rd handler + 1 test); any `manta.claim_work` from a forking-realities clone is rejected (4th handler + 1 test); `manta.broadcast` events get `cast_id` + `cast_mode` stamped on the payload so Phase 2d's `tail` can filter (1 handler + 1 test). All on `@manta/bus`. Self-contained, recon-swarm-regression-guarded.
- **Chunk 2** is skill + spawner reinforcement and the integration sweep: `MANTA_BUS_PEER_SCOPE=parent-only` env var injection by the spawner for forking-realities clones; `manta-as-clone` skill v0.0.3 adds an explicit forking-realities bullet that names the four blocked tools; `manta-coordinate` v0.0.2 adds a main-side discipline note ("contract_refresh payloads must be cast-agnostic"); an integration test (`packages/manta-cli/tests/integration/forking-isolation.test.ts`) spawns two fake forking-realities clones and asserts each Strategy 1 boundary holds end-to-end.

Splitting further (3 chunks) would over-fragment: each Strategy-1 handler edit is ≤30 LOC and one test apiece — bundling them as a single coherent "filter pass" reads more reviewably than four micro-chunks each editing one handler. Strategy 2's spawner edit + skill edit + integration test are also tightly coupled (the integration test exercises the env injection AND the skill update together).

---

## Scope

In-scope (Phase 2b):
- **Schema invariant:** `RegisterInputSchema.refine(...)` enforces `mode === 'forking-realities' → metadata.cast_id present` and `metadata.cast_id` matches a `SafeKey` regex (research-prep §2 second invariant).
- **New `BusForkingIsolationError` class** in `packages/manta-bus/src/errors.ts` with `fromCloneId`, `toCloneId`, `castId`, `tool` fields, mapped to a stable `forking_isolation` envelope in `server.ts` `serializeError`.
- **New helper module** `packages/manta-bus/src/tools/forking-isolation.ts` exposing `siblingsInSameForkingCast(ctx, fromCloneId, toCloneId)` and a thin `crossCloneRead(ctx, callerCloneId, targetCloneId)` cousin for `task_contract.read`. Both pure functions; both read-only against `Registry`.
- **`message` handler reject** — `packages/manta-bus/src/tools/communication.ts:26-40` extension.
- **`broadcast` handler stamp** — same file, lines 16-24 extension. Adds `cast_id` and `cast_mode` to the persisted event payload (forward-compat for Phase 2d `tail`).
- **`task_contract.read` handler reject** — `packages/manta-bus/src/tools/contract.ts` extension. The current schema (`TaskContractReadInputSchema` at `schema.ts:85-89`) only takes `clone_id` — Phase 2b widens it to also take `requesting_clone_id?: string` (optional during transition; required for forking-realities mode in handler logic). Note: `requesting_clone_id` is best-effort defense-in-depth (a malicious clone can still lie); skill-level discipline (Strategy 2) is the primary enforcement, the handler is the audit trail.
- **`claim_work` handler reject** — `packages/manta-bus/src/tools/work.ts` extension. Forking-realities clones cannot claim work (each sibling does the same job in isolation; spec Sec 5.2 work-claim is a recon-swarm/refactor-wave concept).
- **Spawner env injection** — `packages/manta-cli/src/spawner/clone-spawner.ts:95-104` adds `MANTA_BUS_PEER_SCOPE=parent-only` for forking-realities clones, `siblings-allowed` otherwise. The clone reads it in skill text (Strategy 2).
- **`skills/manta-as-clone/SKILL.md`** v0.0.3 → v0.0.4 (current is v0.0.3 from `5cd7234` bug-#9/#10 fix). New `### Forking-realities (Sec 5.8)` bullet listing the four forbidden Bus calls in this mode.
- **`skills/manta-coordinate/SKILL.md`** v0.0.1 → v0.0.2. New main-side note: "When you broadcast a `contract_refresh` to multiple casts, the payload must be cast-agnostic. Per-cast updates use `manta.task_contract.write` per clone."
- **End-to-end integration test** `packages/manta-cli/tests/integration/forking-isolation.test.ts` — spawns two fake forking-realities clones with the existing `fakeCloneRunner`, asserts each Strategy 1 boundary holds.

Out of scope (deferred to other Phase 2 sub-plans, Phase 3+, or explicit non-goals):
- Lock-path containment (research §6 — `BusLockedError.ownerCloneId` soft-info leak). Spec Sec 5.7 PreToolUse hooks land in Phase 5+; Phase 2b keeps the existing `BusLockedError` and accepts the soft leak with a `manta-bugs.md` entry.
- Filesystem-level enforcement (siblings can `cd ../clone-B` if they ignore skill discipline). Skill-level only in Phase 2b; Phase 5+ may add hooks. Documented as a known limit.
- The actual Tier-3 `tail` consumer that uses the new `cast_id`/`cast_mode` event payload — Phase 2d.
- Merge-review, scoring, slash commands — Phase 2c.
- `requesting_clone_id` becoming a transport-verified identity claim — Phase 5 daemon-mode (per-connection identity).

---

## Spec & research alignment

| Spec / research anchor | Demand | This plan's response |
|---|---|---|
| Spec Sec 5.8 (Plagiarism prevention) | Forking-realities clones do not see each other's code/Bus messages until finals | Bus = read-only with main: `message` + `claim_work` + cross-`task_contract.read` rejected (Chunk 1); `broadcast` stays write-only from clone perspective (read-time filtering Phase 2d) |
| Spec Sec 5.5 (Anti-gossip) | Skill forbids "obsuждать чья версия лучше" / self-promotion / social games | `manta-as-clone` v0.0.3 references this verbatim; not a behavioral change, just consolidation |
| Spec Sec 5.7 (Anchor sync) | Main broadcasts contract-refresh; per-cast info must not leak across casts | `manta-coordinate` v0.0.2 main-side note (Chunk 2 Task 2.5) |
| Research clone-C §2 invariants | `metadata.cast_id` required when `mode === forking-realities`; `cast_id` matches safe-key regex | `RegisterInputSchema.refine(...)` (Chunk 1 Task 1.2) |
| Research clone-C §4.2 minimum cut | ≤10-line change in `tools/communication.ts:26-40` rejecting sibling messages | Chunk 1 Task 1.6 implements; helper extracted to its own module per Quality bar |
| Research clone-C §4.3 metadata | `metadata.cast_mode` already populated by Phase 2a (`Registry.register` carries it); filter joins on it | Chunk 1 Task 1.5 helper relies on `cast_mode`, no new metadata field needed |
| Research clone-C §4.4 forward-compat | Manifest `policy.peer_messaging` enum string, not boolean — future modes (council/decoy) slot in | Helper checks `cast_mode === 'forking-realities'` for Phase 2b; Phase 4+ replaces with `cast.policy.peer_messaging === 'denied'` (manifest read) once more modes ship |
| Research clone-C §6 edge cases | `task_contract.read` cross-read; `claim_work` cross-clone visibility; `contract_refresh` payload discipline | Chunk 1 Tasks 1.7 + 1.8 (handlers); Chunk 2 Task 2.5 (skill discipline) |
| Manta-bugs #5 reminder | Skill discipline is not 100 % (Phase 1 dogfood: clones occasionally skipped ZK writes) | Strategy 1 (hard bus reject) is primary; Strategy 2 (skill text) is the explainable safety net |

---

## Quality bar (CLAUDE.md / spec Sec 14)

- Test coverage ≥ 80 % statements/branches on every new/modified file (`packages/manta-bus/src/tools/forking-isolation.ts`, `errors.ts`, `tools/communication.ts`, `tools/contract.ts`, `tools/work.ts`, `server.ts` `serializeError` branch).
- TDD per task: failing test → run → minimal impl → re-run → commit.
- No `// TODO`, `// FIXME`, `it.skip`, `test.skip` in merged code.
- Atomic conventional commits, `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` in each.
- Ships with: skill version bumps committed atomically with the code that depends on them; one-paragraph note in `docs/user/forking-realities.md` (created in Phase 2a) updating the "isolation language" caveat to reflect that Phase 2b has now landed.
- No lint warnings — fix or `// Reason:` suppress with explicit justification.
- Plan reviewer subagent must approve each chunk before it executes.
- Strategy 1's correctness is **closed-set**: every Bus tool is either explicitly allow-listed for forking-realities clones (heartbeat, suicide, report_death, lifecycle, own-clone-id contract reads, contract_refresh-from-main) or explicitly rejected. We enumerate the table in the plan and the integration test (Chunk 2 Task 2.7) walks every entry.

---

## Reference docs

- Source-of-truth design: `docs/superpowers/specs/2026-05-06-manta-pattern-design.md` — Sec 5.5 (anti-gossip), Sec 5.7 (anchor sync), Sec 5.8 (plagiarism prevention), Sec 14 (production quality).
- Predecessor plans: `2026-05-08-phase-2a-forking-spawn.md` (cast manifest + `metadata.cast_mode` — Phase 2b consumes both), `2026-05-06-phase-0b-bus.md` (handler-factory pattern), `2026-05-06-phase-0e-skills-and-commands.md` (skill schema + validator — Phase 2b updates skills under that schema).
- Phase 2 research: `docs/research/phase-2-bus-isolation.md` (clone-C — primary input), `phase-2-codepath-map.md` (clone-A — §4.2 minimum-cut sketch).
- Project rules: `CLAUDE.md` — Quality bar (PROD only), Skill/priming/enforcement HARD RULES, Git rules.
- Pitfalls memo: `docs/internals/claude-code-pitfalls.md` — required read before any skill text edit.

---

## Chunks

1. **Chunk 1 — Strategy 1 (bus-side hard enforcement).** `RegisterInputSchema.refine`; `BusForkingIsolationError` + `serializeError` envelope; new `tools/forking-isolation.ts` helper module; `message` handler reject; `broadcast` handler stamp; `task_contract.read` cross-read reject; `claim_work` reject for forking-realities clones. Six new tests + four modified handlers.
2. **Chunk 2 — Strategy 2 (spawner env + skill discipline + e2e).** Spawner env injection; `manta-as-clone` v0.0.3 forking-realities bullet + `manta-coordinate` v0.0.2 main-side discipline note; `forking-realities.md` operator-doc update (drop the "isolation not yet enforced" caveat, replace with "isolation enforced — full table in `docs/internals/forking-realities-isolation.md`"); end-to-end integration test exercising every Strategy 1 boundary; skill-validator regression sweep.

---

## Chunk 1: Strategy 1 — bus-side hard enforcement

**Goal of this chunk:** A forking-realities clone cannot exfiltrate work-in-progress to a sibling through any of the four sensitive Bus tools. Each rejection comes with a typed `BusForkingIsolationError` and a stable `forking_isolation` wire envelope. The spawner-side schema invariant guarantees the filter has its `metadata.cast_id` join key from day 1.

**Files (new):**
- Create: `packages/manta-bus/src/tools/forking-isolation.ts` — pure helpers + `BusForkingIsolationError` re-export site for handlers.
- Create: `packages/manta-bus/tests/tools/forking-isolation.test.ts` — helper unit tests.
- Create: `packages/manta-bus/tests/tools/communication-forking.test.ts` — message + broadcast handler tests under forking-realities.
- Create: `packages/manta-bus/tests/tools/contract-forking.test.ts` — task_contract.read cross-read reject tests.
- Create: `packages/manta-bus/tests/tools/work-forking.test.ts` — claim_work reject tests.

**Files (modified):**
- Modify: `packages/manta-bus/src/errors.ts:1-46` — add `BusForkingIsolationError` class.
- Modify: `packages/manta-bus/src/server.ts:281-307` — `serializeError` mapping for the new error.
- Modify: `packages/manta-bus/src/schema.ts:27-35` — `RegisterInputSchema.refine(...)` for forking-realities `metadata.cast_id` invariant; widen `TaskContractReadInputSchema` to accept optional `requesting_clone_id`.
- Modify: `packages/manta-bus/src/tools/communication.ts:12-52` — message reject + broadcast stamp.
- Modify: `packages/manta-bus/src/tools/contract.ts:38-42` — task_contract.read cross-read reject.
- Modify: `packages/manta-bus/src/tools/work.ts` — claim_work reject for forking-realities clones (line numbers verified at execute time via `grep -n "claim_work\|claimWork" packages/manta-bus/src/tools/work.ts`).
- Modify: `packages/manta-bus/src/index.ts` — export `BusForkingIsolationError` (already covered by `export * from './errors'` once the class is added). Also re-export the three handler factories `createCommunicationHandlers`, `createContractHandlers`, `createWorkHandlers` from their respective `tools/` modules so the cross-package integration test in Chunk 2 (`packages/manta-cli/tests/integration/forking-isolation.test.ts`) doesn't have to reach into `@manta/bus` internals via path tricks.
- Modify: existing tests for handlers that gain new branches — add forking-realities allow paths so recon-swarm regression-guards.

### File size sanity check

`tools/forking-isolation.ts` projected ≤80 LOC. `errors.ts` grows by ~20 LOC (one class). `tools/communication.ts` grows by ~30 LOC (one helper call + one stamp). `tools/contract.ts` grows by ~25 LOC (one cross-read check). `tools/work.ts` grows by ~20 LOC. `schema.ts` grows by ~15 LOC. `server.ts` `serializeError` grows by 1 case. None of these crosses unwieldy.

### Tasks

- [ ] **1.1: Verify Phase 2a shipped**

```bash
git log --oneline | grep -E "phase-2a" | head -5
test -f packages/manta-bus/src/state/casts.ts && echo "manifest infra present"
test -f packages/manta-bus/src/state/canonicalize.ts && echo "canonicalize present"
grep -q "cast_mode" packages/manta-cli/src/spawner/clone-spawner.ts && echo "cast_mode in spawner"
pnpm -r build && pnpm -r test
```

Expected: every line of output positive; whole-workspace sweep green.
If anything fails, STOP — Chunk 1 depends on Phase 2a's manifest + `metadata.cast_mode` to land.

- [ ] **1.2: `RegisterInputSchema` invariant — failing test first**

**File:** `packages/manta-bus/tests/tools/forking-isolation.test.ts` (NEW; this becomes the helper test file too — kept in one module since both tests share fixtures).

```ts
import { describe, it, expect } from 'vitest';
import { RegisterInputSchema } from '@manta/bus';

describe('RegisterInputSchema (forking-realities invariants)', () => {
  it('accepts a recon-swarm register without metadata.cast_id', () => {
    expect(() =>
      RegisterInputSchema.parse({
        clone_id: 'A',
        mode: 'recon-swarm',
        parent_pid: 1234,
        worktree: '/tmp/wt-A',
        // metadata default {}
      }),
    ).not.toThrow();
  });

  it('rejects a forking-realities register without metadata.cast_id', () => {
    expect(() =>
      RegisterInputSchema.parse({
        clone_id: 'A',
        mode: 'forking-realities',
        parent_pid: 1234,
        worktree: '/tmp/wt-A',
        metadata: {}, // no cast_id
      }),
    ).toThrow(/cast_id/);
  });

  it('rejects forking-realities register with malformed cast_id', () => {
    expect(() =>
      RegisterInputSchema.parse({
        clone_id: 'A',
        mode: 'forking-realities',
        parent_pid: 1234,
        worktree: '/tmp/wt-A',
        metadata: { cast_id: 'cast/../escape' },
      }),
    ).toThrow();
  });

  it('accepts forking-realities register with valid metadata.cast_id', () => {
    expect(() =>
      RegisterInputSchema.parse({
        clone_id: 'A',
        mode: 'forking-realities',
        parent_pid: 1234,
        worktree: '/tmp/wt-A',
        metadata: { cast_id: 'cast-1700000000000', cast_mode: 'forking-realities' },
      }),
    ).not.toThrow();
  });
});
```

Run: `pnpm --filter @manta/bus test -- tests/tools/forking-isolation.test.ts`
Expected: 4 tests fail (the refine isn't there yet).

- [ ] **1.3: Implement the `RegisterInputSchema` refine**

**File:** `packages/manta-bus/src/schema.ts:27-35`

The current declaration:

```ts
export const RegisterInputSchema = z
  .object({
    clone_id: CloneIdSchema,
    mode: ModeSchema,
    parent_pid: z.number().int().positive(),
    worktree: z.string().min(1),
    metadata: z.record(z.string(), z.string()).default({}),
  })
  .strict();
```

Add a `.refine(...)` chain after `.strict()` (Zod permits chaining refine onto a strict object — `.refine` returns a `ZodEffects` which still surfaces parse errors normally):

```ts
const SafeCastIdRegex = /^[A-Za-z0-9._-]+$/;

export const RegisterInputSchema = z
  .object({
    clone_id: CloneIdSchema,
    mode: ModeSchema,
    parent_pid: z.number().int().positive(),
    worktree: z.string().min(1),
    metadata: z.record(z.string(), z.string()).default({}),
  })
  .strict()
  .refine(
    (input) => {
      if (input.mode !== 'forking-realities') return true;
      const id = input.metadata.cast_id;
      return typeof id === 'string' && SafeCastIdRegex.test(id);
    },
    {
      message: 'forking-realities clones must register with metadata.cast_id matching /^[A-Za-z0-9._-]+$/',
      path: ['metadata', 'cast_id'],
    },
  );
```

Note: the regex matches `CastIdSchema` from Phase 2a (`packages/manta-bus/src/schema.ts` near `CastIdSchema`); we duplicate the pattern here rather than import-and-test because `metadata` is `Record<string, string>` (not typed against `CastIdSchema`). Add a comment cross-referencing the pattern source.

Run: `pnpm --filter @manta/bus test -- tests/tools/forking-isolation.test.ts`
Expected: all 4 tests green; Phase 0/1/2a tests stay green (existing register call sites all pass `cast_id` from Phase 1 lockdown — verify `grep -rn "registry.register\|register({" packages/manta-cli/src/`).

- [ ] **1.4: Add `BusForkingIsolationError` (failing test first)**

**File:** `packages/manta-bus/tests/tools/forking-isolation.test.ts` (extend)

```ts
import { BusForkingIsolationError } from '@manta/bus';

describe('BusForkingIsolationError', () => {
  it('captures from/to/cast/tool fields', () => {
    const err = new BusForkingIsolationError({
      tool: 'manta.message',
      fromCloneId: 'A',
      toCloneId: 'B',
      castId: 'cast-1',
    });
    expect(err.name).toBe('BusForkingIsolationError');
    expect(err.tool).toBe('manta.message');
    expect(err.fromCloneId).toBe('A');
    expect(err.toCloneId).toBe('B');
    expect(err.castId).toBe('cast-1');
    expect(err.message).toMatch(/forking-realities/);
    expect(err.message).toMatch(/A.*B/);
  });
});
```

Run: `pnpm --filter @manta/bus test -- tests/tools/forking-isolation.test.ts`
Expected: the test fails because the class is not exported yet.

**File:** `packages/manta-bus/src/errors.ts` (append after `BusLockedError`)

```ts
/**
 * Sec 5.8 plagiarism prevention: a forking-realities clone tried to use a Bus
 * tool that breaks sibling isolation (manta.message to a sibling, cross-clone
 * task_contract.read, claim_work). The bus-side filter rejects loud rather
 * than silently dropping so post-mortem and audit trails record the violation.
 */
export class BusForkingIsolationError extends Error {
  readonly tool: string;
  readonly fromCloneId: string;
  /** Optional — present for message; absent for own-clone violations. */
  readonly toCloneId?: string;
  readonly castId: string;
  constructor(input: {
    tool: string;
    fromCloneId: string;
    toCloneId?: string;
    castId: string;
  }) {
    const target = input.toCloneId ? ` → ${input.toCloneId}` : '';
    super(
      `forking-realities cast ${input.castId}: ${input.tool} from ${input.fromCloneId}${target} is forbidden (Sec 5.8)`,
    );
    this.name = 'BusForkingIsolationError';
    this.tool = input.tool;
    this.fromCloneId = input.fromCloneId;
    this.toCloneId = input.toCloneId;
    this.castId = input.castId;
  }
}
```

**File:** `packages/manta-bus/src/index.ts` — re-export:

```diff
- export * from './errors';
+ export * from './errors'; // includes BusForkingIsolationError
```

(`export *` already covers it once the class is defined; verify by `grep -n "export \*" packages/manta-bus/src/index.ts` — line 2.)

Run: the failing test should now pass.

- [ ] **1.5: Wire `BusForkingIsolationError` into `serializeError`**

**File:** `packages/manta-bus/src/server.ts:281-307` (the existing `serializeError` function — verify line numbers with `grep -n "serializeError\|function serializeError" packages/manta-bus/src/server.ts | head -5`).

Add a branch BEFORE the generic-Error fallback (so the typed envelope wins). Mirror the existing pattern for `BusLockedError`:

```ts
if (err instanceof BusForkingIsolationError) {
  return {
    error: 'forking_isolation',
    message: err.message,
    details: {
      tool: err.tool,
      from: err.fromCloneId,
      to: err.toCloneId ?? null,
      cast_id: err.castId,
    },
  };
}
```

Add a test in `packages/manta-bus/tests/server.test.ts` (extend existing `serializeError` tests — search with `grep -n "serializeError" packages/manta-bus/tests/server.test.ts | head -5`):

```ts
it('serializes BusForkingIsolationError as forking_isolation envelope', () => {
  const err = new BusForkingIsolationError({
    tool: 'manta.message',
    fromCloneId: 'A',
    toCloneId: 'B',
    castId: 'cast-1',
  });
  expect(serializeError(err)).toEqual({
    error: 'forking_isolation',
    message: expect.stringContaining('forking-realities'),
    details: { tool: 'manta.message', from: 'A', to: 'B', cast_id: 'cast-1' },
  });
});
```

Run: `pnpm --filter @manta/bus test -- tests/server.test.ts`
Expected: the new test green; existing `serializeError` cases stay green.

- [ ] **1.6: Implement `siblingsInSameForkingCast` helper + `crossCloneRead`**

**File (new):** `packages/manta-bus/src/tools/forking-isolation.ts`

```ts
import type { BusContext } from './index';

/**
 * True iff both clones exist, both belong to the same forking-realities
 * cast, and they are different. False otherwise (including: one of them is
 * a recon-swarm clone, the cast_ids differ, the clone_ids are equal).
 *
 * Read-only; uses Registry only. ~µs of file IO via atomicReadJson.
 *
 * Phase 2 keys on `cast_mode === 'forking-realities'`. Phase 4+ swaps to
 * a manifest read (`ctx.casts.read(cast_id).policy.peer_messaging === 'denied'`)
 * once more modes need partial-isolation policies; the call sites stay the
 * same, only this helper changes.
 *
 * Discriminated-union return: when `same: true`, `castId: string` is
 * guaranteed non-null (call sites can use `result.castId` without `!`).
 */
export type SiblingCheck =
  | { same: false }
  | { same: true; castId: string };

export async function siblingsInSameForkingCast(
  ctx: Pick<BusContext, 'registry'>,
  fromCloneId: string,
  toCloneId: string,
): Promise<SiblingCheck> {
  if (fromCloneId === toCloneId) return { same: false };
  const [from, to] = await Promise.all([
    ctx.registry.get(fromCloneId),
    ctx.registry.get(toCloneId),
  ]);
  // Phase 2a's spawner sets metadata.cast_mode + metadata.cast_id, and
  // RegisterInputSchema.refine (this plan, Task 1.3) makes cast_id
  // mandatory + safe-key-validated for forking-realities mode. So if
  // metadata.cast_mode === 'forking-realities' for both peers, cast_id
  // is guaranteed present + safe.
  if (from.metadata.cast_mode !== 'forking-realities') return { same: false };
  if (to.metadata.cast_mode !== 'forking-realities') return { same: false };
  const castId = from.metadata.cast_id;
  // Defensive: cover the impossible-per-schema case where metadata.cast_id
  // is missing despite cast_mode being 'forking-realities'. Falling
  // through to `same: false` is fail-safe (allow, don't reject).
  if (!castId) return { same: false };
  if (castId !== to.metadata.cast_id) return { same: false };
  return { same: true, castId };
}

/**
 * True iff `caller` is a forking-realities clone and `target` is a different
 * clone_id. Used by `task_contract.read` to deny cross-clone reads.
 *
 * If `caller === target` or caller is recon-swarm/etc., returns blocked:false.
 * If the caller is unknown (not in registry), returns blocked:false (the
 * handler's existing not_found path takes over).
 *
 * Discriminated-union return: when `blocked: true`, `castId: string` is
 * guaranteed non-null (per Task 1.3 schema refine).
 */
export type CrossReadCheck =
  | { blocked: false }
  | { blocked: true; castId: string };

export async function crossCloneRead(
  ctx: Pick<BusContext, 'registry'>,
  callerCloneId: string,
  targetCloneId: string,
): Promise<CrossReadCheck> {
  if (callerCloneId === targetCloneId) return { blocked: false };
  const caller = await ctx.registry.get(callerCloneId).catch(() => null);
  if (!caller) return { blocked: false };
  if (caller.metadata.cast_mode !== 'forking-realities') return { blocked: false };
  const castId = caller.metadata.cast_id;
  // Same fail-safe as siblingsInSameForkingCast — impossible per schema,
  // but if it happens, allow (don't reject with a meaningless error).
  if (!castId) return { blocked: false };
  return { blocked: true, castId };
}
```

**Tests:** append to `packages/manta-bus/tests/tools/forking-isolation.test.ts`

```ts
import { siblingsInSameForkingCast, crossCloneRead } from '../../src/tools/forking-isolation';
import { Registry, busPaths, FakeClock } from '@manta/bus';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function tmpRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'manta-fi-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function setupCtx(dir: string) {
  const paths = busPaths(dir);
  const registry = new Registry(paths, new FakeClock(1700000000000));
  return { registry };
}

describe('siblingsInSameForkingCast', () => {
  it('returns same:true for two FR siblings of the same cast', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const ctx = await setupCtx(dir);
      await ctx.registry.register({
        clone_id: 'A',
        mode: 'forking-realities',
        parent_pid: 1,
        worktree: '/tmp/A',
        metadata: { cast_id: 'cast-1', cast_mode: 'forking-realities' },
      });
      await ctx.registry.register({
        clone_id: 'B',
        mode: 'forking-realities',
        parent_pid: 1,
        worktree: '/tmp/B',
        metadata: { cast_id: 'cast-1', cast_mode: 'forking-realities' },
      });
      const result = await siblingsInSameForkingCast(ctx, 'A', 'B');
      // Discriminated-union: assert the success case carries castId.
      expect(result.same).toBe(true);
      if (result.same) expect(result.castId).toBe('cast-1');
    } finally {
      cleanup();
    }
  });

  it('returns same:false for two recon-swarm clones', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const ctx = await setupCtx(dir);
      await ctx.registry.register({
        clone_id: 'A',
        mode: 'recon-swarm',
        parent_pid: 1,
        worktree: '/tmp/A',
        metadata: { cast_id: 'cast-1', cast_mode: 'recon-swarm' },
      });
      await ctx.registry.register({
        clone_id: 'B',
        mode: 'recon-swarm',
        parent_pid: 1,
        worktree: '/tmp/B',
        metadata: { cast_id: 'cast-1', cast_mode: 'recon-swarm' },
      });
      const result = await siblingsInSameForkingCast(ctx, 'A', 'B');
      expect(result.same).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('returns same:false for FR clones across different casts', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const ctx = await setupCtx(dir);
      await ctx.registry.register({
        clone_id: 'A',
        mode: 'forking-realities',
        parent_pid: 1,
        worktree: '/tmp/A',
        metadata: { cast_id: 'cast-1', cast_mode: 'forking-realities' },
      });
      await ctx.registry.register({
        clone_id: 'B',
        mode: 'forking-realities',
        parent_pid: 1,
        worktree: '/tmp/B',
        metadata: { cast_id: 'cast-2', cast_mode: 'forking-realities' },
      });
      const result = await siblingsInSameForkingCast(ctx, 'A', 'B');
      expect(result.same).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('returns same:false for self (A === A)', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const ctx = await setupCtx(dir);
      const result = await siblingsInSameForkingCast(ctx, 'A', 'A');
      expect(result.same).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe('crossCloneRead', () => {
  it('blocks FR clone reading another clone_id', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const ctx = await setupCtx(dir);
      await ctx.registry.register({
        clone_id: 'A',
        mode: 'forking-realities',
        parent_pid: 1,
        worktree: '/tmp/A',
        metadata: { cast_id: 'cast-1', cast_mode: 'forking-realities' },
      });
      const result = await crossCloneRead(ctx, 'A', 'B');
      expect(result.blocked).toBe(true);
      if (result.blocked) expect(result.castId).toBe('cast-1');
    } finally {
      cleanup();
    }
  });

  it('allows FR clone reading own clone_id', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const ctx = await setupCtx(dir);
      await ctx.registry.register({
        clone_id: 'A',
        mode: 'forking-realities',
        parent_pid: 1,
        worktree: '/tmp/A',
        metadata: { cast_id: 'cast-1', cast_mode: 'forking-realities' },
      });
      const result = await crossCloneRead(ctx, 'A', 'A');
      expect(result.blocked).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('allows recon-swarm clone reading any clone_id', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const ctx = await setupCtx(dir);
      await ctx.registry.register({
        clone_id: 'A',
        mode: 'recon-swarm',
        parent_pid: 1,
        worktree: '/tmp/A',
        metadata: { cast_id: 'cast-1', cast_mode: 'recon-swarm' },
      });
      const result = await crossCloneRead(ctx, 'A', 'B');
      expect(result.blocked).toBe(false);
    } finally {
      cleanup();
    }
  });
});
```

Run: `pnpm --filter @manta/bus test -- tests/tools/forking-isolation.test.ts`
Expected: every test green.

- [ ] **1.7: `message` handler reject (failing test first)**

**File:** `packages/manta-bus/tests/tools/communication-forking.test.ts` (NEW)

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBusServer } from '@manta/bus';

async function tmpHandle() {
  const dir = mkdtempSync(join(tmpdir(), 'manta-comm-fr-'));
  const handle = await createBusServer({ repoRoot: dir });
  return { dir, handle, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('manta.message under forking-realities', () => {
  it('rejects sibling-to-sibling messages with forking_isolation envelope', async () => {
    const { dir, handle, cleanup } = await tmpHandle();
    try {
      await handle.context.registry.register({
        clone_id: 'A',
        mode: 'forking-realities',
        parent_pid: 1,
        worktree: '/tmp/A',
        metadata: { cast_id: 'cast-1', cast_mode: 'forking-realities' },
      });
      await handle.context.registry.register({
        clone_id: 'B',
        mode: 'forking-realities',
        parent_pid: 1,
        worktree: '/tmp/B',
        metadata: { cast_id: 'cast-1', cast_mode: 'forking-realities' },
      });
      // Find the comm handler by re-creating it with the same context (mirror
      // existing tests in tests/tools/communication.test.ts):
      const { createCommunicationHandlers } = await import('../../src/tools/communication');
      // (If the import path differs, use the test pattern at
      // packages/manta-bus/tests/tools/communication.test.ts.)
      const handlers = createCommunicationHandlers(handle.context);
      await expect(
        handlers.message({
          from_clone_id: 'A',
          to_clone_id: 'B',
          payload: { exfil: 'my draft solution' },
        }),
      ).rejects.toMatchObject({
        name: 'BusForkingIsolationError',
        fromCloneId: 'A',
        toCloneId: 'B',
        castId: 'cast-1',
      });
    } finally {
      cleanup();
    }
  });

  it('allows recon-swarm sibling-to-sibling messages (regression guard)', async () => {
    const { dir, handle, cleanup } = await tmpHandle();
    try {
      await handle.context.registry.register({
        clone_id: 'A',
        mode: 'recon-swarm',
        parent_pid: 1,
        worktree: '/tmp/A',
        metadata: { cast_id: 'cast-1', cast_mode: 'recon-swarm' },
      });
      await handle.context.registry.register({
        clone_id: 'B',
        mode: 'recon-swarm',
        parent_pid: 1,
        worktree: '/tmp/B',
        metadata: { cast_id: 'cast-1', cast_mode: 'recon-swarm' },
      });
      const { createCommunicationHandlers } = await import('../../src/tools/communication');
      const handlers = createCommunicationHandlers(handle.context);
      const r = await handlers.message({
        from_clone_id: 'A',
        to_clone_id: 'B',
        payload: { msg: 'hi' },
      });
      expect(r.event.type).toBe('message');
    } finally {
      cleanup();
    }
  });

  it('allows FR clone messaging across different casts (cast-id mismatch falls through)', async () => {
    const { dir, handle, cleanup } = await tmpHandle();
    try {
      await handle.context.registry.register({
        clone_id: 'A',
        mode: 'forking-realities',
        parent_pid: 1,
        worktree: '/tmp/A',
        metadata: { cast_id: 'cast-1', cast_mode: 'forking-realities' },
      });
      await handle.context.registry.register({
        clone_id: 'X',
        mode: 'forking-realities',
        parent_pid: 1,
        worktree: '/tmp/X',
        metadata: { cast_id: 'cast-2', cast_mode: 'forking-realities' },
      });
      const { createCommunicationHandlers } = await import('../../src/tools/communication');
      const handlers = createCommunicationHandlers(handle.context);
      // Cross-cast messaging is bizarre but not a Sec 5.8 violation —
      // research §6 explicitly notes this falls through to existing
      // behaviour. Acceptable.
      const r = await handlers.message({
        from_clone_id: 'A',
        to_clone_id: 'X',
        payload: { msg: 'cross-cast' },
      });
      expect(r.event.type).toBe('message');
    } finally {
      cleanup();
    }
  });
});
```

Run: `pnpm --filter @manta/bus test -- tests/tools/communication-forking.test.ts`
Expected: 3 tests fail (handler hasn't been edited yet).

- [ ] **1.8: Implement the `message` reject + `broadcast` stamp**

**File:** `packages/manta-bus/src/tools/communication.ts:12-52`

The current handlers (verified in this session). Edit:

```ts
import { BroadcastInputSchema, DriftReportInputSchema, MessageInputSchema } from '../schema';
import type { BusContext } from './index';
import { parse } from './parse';
import { siblingsInSameForkingCast } from './forking-isolation';
import { BusForkingIsolationError } from '../errors';
import type { BusEvent } from '../state/events';

export interface CommunicationHandlers {
  broadcast(input: unknown): Promise<{ event: BusEvent }>;
  message(input: unknown): Promise<{ event: BusEvent }>;
  driftReport(input: unknown): Promise<{ event: BusEvent }>;
}

export function createCommunicationHandlers(
  ctx: Pick<BusContext, 'events' | 'registry'>,
): CommunicationHandlers {
  return {
    async broadcast(input) {
      const parsed = parse(BroadcastInputSchema, input, 'broadcast');
      // Stamp cast_id + cast_mode on every broadcast event so Phase 2d's
      // `tail` consumer can filter by cast membership before delivering to
      // a tailing sibling. The lookup is one Registry.get per broadcast —
      // µs-scale cost, dwarfed by the file-mutex the events log is about
      // to take.
      const r = await ctx.registry.get(parsed.clone_id);
      const event = await ctx.events.append({
        type: 'broadcast',
        clone_id: parsed.clone_id,
        payload: {
          event_type: parsed.event_type,
          body: parsed.payload,
          cast_id: r.metadata.cast_id ?? null,
          cast_mode: r.metadata.cast_mode ?? null,
        },
      });
      return { event };
    },

    async message(input) {
      const parsed = parse(MessageInputSchema, input, 'message');
      // Verify both clones exist (preserves existing not_found semantics —
      // an unknown peer must fail with `not_found`, not `forking_isolation`).
      // The lookups happen for their side effect (throw on miss) before
      // the FR filter consults the registry again via the helper.
      await Promise.all([
        ctx.registry.get(parsed.from_clone_id),
        ctx.registry.get(parsed.to_clone_id),
      ]);
      // Sec 5.8 plagiarism prevention — sibling-to-sibling messaging
      // forbidden inside a forking-realities cast.
      const sib = await siblingsInSameForkingCast(
        { registry: ctx.registry },
        parsed.from_clone_id,
        parsed.to_clone_id,
      );
      if (sib.same) {
        throw new BusForkingIsolationError({
          tool: 'manta.message',
          fromCloneId: parsed.from_clone_id,
          toCloneId: parsed.to_clone_id,
          // The helper guarantees castId is non-null whenever same===true
          // (see siblingsInSameForkingCast — it returns
          // { same: true, castId: <string> } only when castId matched
          // between both peers, which the schema refine in Task 1.3 makes
          // impossible to be empty).
          castId: sib.castId,
        });
      }
      const event = await ctx.events.append({
        type: 'message',
        clone_id: parsed.from_clone_id,
        payload: { from: parsed.from_clone_id, to: parsed.to_clone_id, body: parsed.payload },
      });
      return { event };
    },

    async driftReport(input) {
      const parsed = parse(DriftReportInputSchema, input, 'drift_report');
      const event = await ctx.events.append({
        type: 'drift_report',
        clone_id: parsed.clone_id,
        payload: { score: parsed.score, evidence: parsed.evidence },
      });
      return { event };
    },
  };
}
```

The `void from; void to;` line is intentional — the `Promise.all` is what asserts both clones exist (replaces the two sequential `await ctx.registry.get(...)` calls at the original lines 32-33). If we drop one `await`, an unknown `to_clone_id` could pass the filter check (because `siblingsInSameForkingCast` calls `registry.get` for both internally and may not throw — verify by reading the helper). Keeping the explicit `Promise.all` preserves the original not_found semantics in their exact original location.

Add an existing-broadcast regression test at `packages/manta-bus/tests/tools/communication.test.ts` (recon-swarm broadcast still works; payload now carries `cast_id` and `cast_mode`):

```ts
it('broadcast event payload now carries cast_id and cast_mode', async () => {
  // existing fixture: register a recon-swarm clone with metadata
  await registry.register({
    clone_id: 'A',
    mode: 'recon-swarm',
    parent_pid: 1,
    worktree: '/tmp/A',
    metadata: { cast_id: 'cast-bx', cast_mode: 'recon-swarm' },
  });
  const r = await handlers.broadcast({
    clone_id: 'A',
    event_type: 'breakthrough',
    payload: { what: 'something' },
  });
  expect(r.event.payload).toEqual({
    event_type: 'breakthrough',
    body: { what: 'something' },
    cast_id: 'cast-bx',
    cast_mode: 'recon-swarm',
  });
});
```

Run: `pnpm --filter @manta/bus test -- tests/tools/`
Expected: every test (existing + new from Tasks 1.6 / 1.7) green.

- [ ] **1.9: `task_contract.read` cross-read reject (failing test first)**

**File:** `packages/manta-bus/tests/tools/contract-forking.test.ts` (NEW)

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBusServer } from '@manta/bus';

async function tmpHandle() {
  const dir = mkdtempSync(join(tmpdir(), 'manta-cf-'));
  const handle = await createBusServer({ repoRoot: dir });
  return { dir, handle, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('manta.task_contract.read under forking-realities', () => {
  it('rejects FR clone reading another clone\'s contract', async () => {
    const { handle, cleanup } = await tmpHandle();
    try {
      await handle.context.registry.register({
        clone_id: 'A',
        mode: 'forking-realities',
        parent_pid: 1,
        worktree: '/tmp/A',
        metadata: { cast_id: 'cast-1', cast_mode: 'forking-realities' },
      });
      await handle.context.contracts.write({
        clone_id: 'B',
        mode: 'forking-realities',
        task: 'B-secret',
        scope: { allowed_paths: ['.'], forbidden_paths: [], max_files_changed: 1 },
        sibling_clones: ['A'],
        deadline_ms: 1_200_000,
      });
      const { createContractHandlers } = await import('../../src/tools/contract');
      const handlers = createContractHandlers(handle.context);
      // A asks for B's contract — must be rejected.
      await expect(
        handlers.read({ clone_id: 'B', requesting_clone_id: 'A' }),
      ).rejects.toMatchObject({ name: 'BusForkingIsolationError', tool: 'manta.task_contract.read' });
    } finally {
      cleanup();
    }
  });

  it('allows FR clone reading own contract', async () => {
    const { handle, cleanup } = await tmpHandle();
    try {
      await handle.context.registry.register({
        clone_id: 'A',
        mode: 'forking-realities',
        parent_pid: 1,
        worktree: '/tmp/A',
        metadata: { cast_id: 'cast-1', cast_mode: 'forking-realities' },
      });
      await handle.context.contracts.write({
        clone_id: 'A',
        mode: 'forking-realities',
        task: 'A-task',
        scope: { allowed_paths: ['.'], forbidden_paths: [], max_files_changed: 1 },
        sibling_clones: ['B'],
        deadline_ms: 1_200_000,
      });
      const { createContractHandlers } = await import('../../src/tools/contract');
      const handlers = createContractHandlers(handle.context);
      const r = await handlers.read({ clone_id: 'A', requesting_clone_id: 'A' });
      expect(r.stored.contract.task).toBe('A-task');
    } finally {
      cleanup();
    }
  });

  it('allows recon-swarm cross-clone reads (regression guard)', async () => {
    const { handle, cleanup } = await tmpHandle();
    try {
      await handle.context.registry.register({
        clone_id: 'A',
        mode: 'recon-swarm',
        parent_pid: 1,
        worktree: '/tmp/A',
        metadata: { cast_id: 'cast-1', cast_mode: 'recon-swarm' },
      });
      await handle.context.contracts.write({
        clone_id: 'B',
        mode: 'recon-swarm',
        task: 'B-task',
        scope: { allowed_paths: ['.'], forbidden_paths: [], max_files_changed: 1 },
        sibling_clones: ['A'],
        deadline_ms: 1_200_000,
      });
      const { createContractHandlers } = await import('../../src/tools/contract');
      const handlers = createContractHandlers(handle.context);
      // Recon-swarm A reads B's contract — allowed (collaborative mode).
      const r = await handlers.read({ clone_id: 'B', requesting_clone_id: 'A' });
      expect(r.stored.contract.task).toBe('B-task');
    } finally {
      cleanup();
    }
  });

  it('handler accepts requesting_clone_id omission for backward-compat', async () => {
    // Recon-swarm callers from Phase 0/1 don't pass requesting_clone_id.
    // The handler must NOT reject just because the field is missing — it
    // only rejects on the active forking-realities cross-read path.
    const { handle, cleanup } = await tmpHandle();
    try {
      await handle.context.contracts.write({
        clone_id: 'A',
        mode: 'recon-swarm',
        task: 'A-task',
        scope: { allowed_paths: ['.'], forbidden_paths: [], max_files_changed: 1 },
        sibling_clones: [],
        deadline_ms: 1_200_000,
      });
      const { createContractHandlers } = await import('../../src/tools/contract');
      const handlers = createContractHandlers(handle.context);
      const r = await handlers.read({ clone_id: 'A' });
      expect(r.stored.contract.task).toBe('A-task');
    } finally {
      cleanup();
    }
  });
});
```

Run: `pnpm --filter @manta/bus test -- tests/tools/contract-forking.test.ts`
Expected: 4 tests fail (handler not yet edited; schema doesn't yet accept `requesting_clone_id`).

- [ ] **1.10: Widen `TaskContractReadInputSchema` + implement the reject**

**File:** `packages/manta-bus/src/schema.ts:85-89`

```diff
  export const TaskContractReadInputSchema = z
    .object({
      clone_id: CloneIdSchema,
+     /**
+      * Identity of the calling clone (best-effort defense-in-depth).
+      * Phase 2b: handler rejects when caller is forking-realities and
+      * `requesting_clone_id !== clone_id`. Until per-connection identity
+      * lands (Phase 5 daemon-mode), this field is operator-trusted; skill
+      * discipline (manta-as-clone v0.0.3) is the primary enforcement.
+      */
+     requesting_clone_id: CloneIdSchema.optional(),
    })
    .strict();
```

**File:** `packages/manta-bus/src/tools/contract.ts:38-42` (verified in this session that `read` lives there; verify with `grep -n "task_contract.read\|read:" packages/manta-bus/src/tools/contract.ts`).

```ts
import { crossCloneRead } from './forking-isolation';
import { BusForkingIsolationError } from '../errors';

// ... inside createContractHandlers ...

async read(input) {
  const parsed = parse(TaskContractReadInputSchema, input, 'task_contract.read');
  // Sec 5.8 cross-clone read enforcement. requesting_clone_id is optional
  // for back-compat with Phase 0/1 callers; when present, we apply the
  // forking-realities cross-read filter.
  if (parsed.requesting_clone_id) {
    const cr = await crossCloneRead(
      { registry: ctx.registry },
      parsed.requesting_clone_id,
      parsed.clone_id,
    );
    if (cr.blocked) {
      throw new BusForkingIsolationError({
        tool: 'manta.task_contract.read',
        fromCloneId: parsed.requesting_clone_id,
        // No `to` for cross-read — envelope shows null.
        castId: cr.castId, // discriminated-union narrowing: `blocked: true` → castId: string
      });
    }
    // Audit: log every forking-realities cross-attempt to events.log so
    // post-mortem can flag the violation pattern. Skill discipline is the
    // primary check (Strategy 2); the events.log entry is the audit trail.
    await ctx.events.append({
      type: 'forking_isolation_attempt',
      clone_id: parsed.requesting_clone_id,
      payload: {
        tool: 'manta.task_contract.read',
        target: parsed.clone_id,
        cast_id: cr.castId,
      },
    });
  }
  // Existing read path — unchanged.
  const stored = await ctx.contracts.read(parsed.clone_id);
  return { contract: stored };
}
```

Note: the `forking_isolation_attempt` event type is new. The `BusEvent.type` field at `packages/manta-bus/src/state/events.ts:10` is declared as an open `string` (not a `z.enum`), so no schema widening is required. Verify by `grep -n "type:" packages/manta-bus/src/state/events.ts` — it reads `type: string;`. The only concern is whether downstream `readSince` consumers assert closed-set on the `type` field; verify with `grep -rn "event.type ===\|switch (.*type" packages/` — if any caller asserts a closed enum, it must be widened to tolerate the new value (or have a `default:` branch).

Run: `pnpm --filter @manta/bus test -- tests/tools/contract-forking.test.ts`
Expected: every test green.

- [ ] **1.11: `claim_work` reject for forking-realities (failing test first)**

**File:** `packages/manta-bus/tests/tools/work-forking.test.ts` (NEW; mirror the structure of `contract-forking.test.ts`).

Three tests: (1) FR clone calling `manta.claim_work` → rejected; (2) recon-swarm clone calling `manta.claim_work` → succeeds (regression); (3) FR clone calling `manta.release_work` for a non-existent claim → unaffected by the new check (should still hit the existing `not_found` branch — release isn't blocked, only `claim_work` is, since the work-claim board is read-only-by-design under Sec 5.8).

```ts
describe('manta.claim_work under forking-realities', () => {
  it('rejects FR clone with forking_isolation envelope', async () => {
    const { handle, cleanup } = await tmpHandle();
    try {
      await handle.context.registry.register({
        clone_id: 'A',
        mode: 'forking-realities',
        parent_pid: 1,
        worktree: '/tmp/A',
        metadata: { cast_id: 'cast-1', cast_mode: 'forking-realities' },
      });
      const { createWorkHandlers } = await import('../../src/tools/work');
      const handlers = createWorkHandlers(handle.context);
      await expect(
        handlers.claim({ clone_id: 'A', item: 'task-1', timeout_ms: 60_000 }),
      ).rejects.toMatchObject({
        name: 'BusForkingIsolationError',
        tool: 'manta.claim_work',
        fromCloneId: 'A',
        castId: 'cast-1',
      });
    } finally {
      cleanup();
    }
  });

  it('allows recon-swarm clone (regression guard)', async () => {
    const { handle, cleanup } = await tmpHandle();
    try {
      await handle.context.registry.register({
        clone_id: 'A',
        mode: 'recon-swarm',
        parent_pid: 1,
        worktree: '/tmp/A',
        metadata: { cast_id: 'cast-1', cast_mode: 'recon-swarm' },
      });
      const { createWorkHandlers } = await import('../../src/tools/work');
      const handlers = createWorkHandlers(handle.context);
      const r = await handlers.claim({ clone_id: 'A', item: 'task-1', timeout_ms: 60_000 });
      // Phase 0b interface (work.ts:14-34): claim handler returns { claim, event }
      expect(r.claim.item).toBe('task-1');
    } finally {
      cleanup();
    }
  });

  it('release_work for FR clone falls through to existing semantics', async () => {
    const { handle, cleanup } = await tmpHandle();
    try {
      await handle.context.registry.register({
        clone_id: 'A',
        mode: 'forking-realities',
        parent_pid: 1,
        worktree: '/tmp/A',
        metadata: { cast_id: 'cast-1', cast_mode: 'forking-realities' },
      });
      const { createWorkHandlers } = await import('../../src/tools/work');
      const handlers = createWorkHandlers(handle.context);
      // Releasing without holding — existing behaviour throws not_found.
      // Phase 2b does NOT widen the FR-reject to release_work; the FR
      // clone never claimed in the first place, so release is a no-op
      // edge case, not a plagiarism vector.
      await expect(
        handlers.release({ clone_id: 'A', item: 'task-1' }),
      ).rejects.toMatchObject({ name: 'BusNotFoundError' });
    } finally {
      cleanup();
    }
  });
});
```

Run: `pnpm --filter @manta/bus test -- tests/tools/work-forking.test.ts`
Expected: 3 tests fail.

- [ ] **1.12: Implement the `claim_work` reject**

**File:** `packages/manta-bus/src/tools/work.ts` — verify exact line numbers via `grep -n "claim_work\|claim\b\|claimWork" packages/manta-bus/src/tools/work.ts`. Edit the `claim` handler (the analogue of the `message` handler's reject):

```ts
// Note: siblingsInSameForkingCast is NOT imported here — claim_work has no
// to_clone_id; the check is on the CALLER's mode only. Direct branch off
// Registry.get is correct.
import { BusForkingIsolationError, BusStateError } from '../errors';

// ... inside createWorkHandlers ...

async claim(input) {
  const parsed = parse(ClaimWorkInputSchema, input, 'claim_work');
  // Sec 5.8 — work-claim board is read-only for forking-realities clones.
  // Each sibling does the same job in isolation; claiming is conceptually
  // a no-op AND a soft-info leak (sibling sees who claimed what).
  const r = await ctx.registry.get(parsed.clone_id);
  if (r.metadata.cast_mode === 'forking-realities') {
    // Per Task 1.3 schema refine, FR clones in the registry are guaranteed
    // to have metadata.cast_id non-empty + safe-key. So no fallback needed;
    // if it's somehow missing, `r.metadata.cast_id!` would still be the
    // literal string 'undefined' in the envelope which is a louder bug
    // signal than `<unknown>`.
    if (!r.metadata.cast_id) {
      // Fail-safe: if invariant breaks (impossible per schema), surface it
      // as a 500-class state error rather than spawning an isolation error
      // with a meaningless castId.
      throw new BusStateError(
        `forking-realities clone ${parsed.clone_id} registered without metadata.cast_id (Phase 2b schema invariant violation)`,
      );
    }
    throw new BusForkingIsolationError({
      tool: 'manta.claim_work',
      fromCloneId: parsed.clone_id,
      castId: r.metadata.cast_id,
    });
  }
  // Existing path — unchanged.
  // ... (preserve the current claim implementation verbatim) ...
}
```

Note: the helper `siblingsInSameForkingCast` is NOT used here — `claim_work` has no `to_clone_id`; we only need to check whether the *caller* is a forking-realities clone. The branch is direct.

Run: `pnpm --filter @manta/bus test -- tests/tools/work-forking.test.ts`
Expected: every test green.

- [ ] **1.13a: Re-export handler factories from `@manta/bus` index**

**File:** `packages/manta-bus/src/index.ts`

Append after the existing `export * from './schema'` block (per `index.ts:1-22`):

```ts
export { createCommunicationHandlers } from './tools/communication';
export type { CommunicationHandlers } from './tools/communication';
export { createContractHandlers } from './tools/contract';
export type { ContractHandlers } from './tools/contract';
export { createWorkHandlers } from './tools/work';
export type { WorkHandlers } from './tools/work';
```

(Verify the actual exported type names with `grep -n "export interface" packages/manta-bus/src/tools/{communication,contract,work}.ts`. The factory names are stable per the existing pattern in `server.ts:101-106`.)

This is a tiny, additive index edit; no test required beyond the cross-package integration test in Chunk 2 Task 2.5 that consumes it. Build sanity:

```bash
pnpm --filter @manta/bus build && pnpm --filter @manta/cli build
```

Expected: green.

- [ ] **1.13: Whole-package sweep**

```bash
pnpm --filter @manta/bus build && \
  pnpm --filter @manta/bus test && \
  pnpm --filter @manta/bus lint
```

Expected: green build, green test sweep, no lint warnings. New tests added by tasks 1.2 / 1.4 / 1.5 / 1.6 / 1.7 / 1.9 / 1.11 (≈18 cases). Existing recon-swarm regression guards green.

- [ ] **1.14: Commit Chunk 1**

```bash
git add packages/manta-bus/src/schema.ts \
        packages/manta-bus/src/errors.ts \
        packages/manta-bus/src/server.ts \
        packages/manta-bus/src/tools/forking-isolation.ts \
        packages/manta-bus/src/tools/communication.ts \
        packages/manta-bus/src/tools/contract.ts \
        packages/manta-bus/src/tools/work.ts \
        packages/manta-bus/src/state/events.ts \
        packages/manta-bus/src/index.ts \
        packages/manta-bus/tests/tools/forking-isolation.test.ts \
        packages/manta-bus/tests/tools/communication-forking.test.ts \
        packages/manta-bus/tests/tools/contract-forking.test.ts \
        packages/manta-bus/tests/tools/work-forking.test.ts \
        packages/manta-bus/tests/tools/communication.test.ts \
        packages/manta-bus/tests/server.test.ts

# CLAUDE.md HARD RULE: take author from `git log`. Use a tab separator
# because author names contain spaces ("Tim Hunt") and ${VAR% *} would
# strip the wrong token.
EMAIL="$(git log -1 --format='%ae')"
NAME="$(git log -1 --format='%an')"
git -c user.email="$EMAIL" -c user.name="$NAME" commit -m "$(cat <<'EOF'
feat(phase-2b): bus-side forking-realities isolation (Strategy 1)

Spec Sec 5.8 plagiarism prevention enforced at the bus layer. Four sensitive
tools now reject sibling-leak vectors with a typed BusForkingIsolationError
and a stable `forking_isolation` wire envelope.

* RegisterInputSchema.refine — FR clones must register with metadata.cast_id
  matching /^[A-Za-z0-9._-]+$/ (Phase 2a's spawner already does; this
  promotes the invariant to schema layer).
* TaskContractReadInputSchema accepts optional requesting_clone_id; FR cross-
  clone reads rejected. Best-effort until per-connection identity in Phase 5.
* New tools/forking-isolation.ts with siblingsInSameForkingCast +
  crossCloneRead helpers — read-only against Registry, µs cost, Phase 4+
  swap to manifest.read once policy.peer_messaging is multi-valued.
* manta.message — reject sibling-to-sibling in same FR cast (Sec 5.8 vector).
* manta.broadcast — stamp event payload with cast_id + cast_mode for Phase
  2d's `tail` to filter cast-scoped views.
* manta.task_contract.read — reject FR cross-clone reads + audit-log
  `forking_isolation_attempt` event (post-mortem can flag pattern).
* manta.claim_work — reject FR clones (work-claim board is recon-swarm/
  refactor-wave concept; FR siblings doing same job is identical-claim
  collision + soft-info leak via owner field on conflict).

Tests: schema invariant (4), helpers (8), message+broadcast (3 + 1),
contract read (4), claim_work (3) — 23 new cases. Recon-swarm regression
guards green across the existing tests/tools sweep.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Verify: `git log --oneline -1` shows `feat(phase-2b)`; `git status` clean.

---

## Chunk 2: Strategy 2 — spawner env + skill discipline + e2e

**Goal of this chunk:** Honest forking-realities clones never *try* the rejected operations because their skill explicitly forbids them; the spawner injects an env var so the clone can detect at runtime which scope applies. The end-to-end integration test exercises every Chunk 1 boundary against a real `fakeCloneRunner` to catch wiring drift between the spawner, the skill, and the bus filter.

**Files (new):**
- Create: `packages/manta-cli/tests/integration/forking-isolation.test.ts` — e2e exercising all 4 boundaries.
- Create: `docs/internals/forking-realities-isolation.md` — closed-set table of every Bus tool + its forking-realities allow/reject status. Internal doc, not user-facing.

**Files (modified):**
- Modify: `packages/manta-cli/src/spawner/clone-spawner.ts:95-104` — env var injection.
- Modify: `packages/manta-cli/tests/spawner/clone-spawner.test.ts` — assert env var is passed.
- Modify: `skills/manta-as-clone/SKILL.md` — bump version to v0.0.3, add `### Forking-realities isolation` section.
- Modify: `skills/manta-coordinate/SKILL.md` — bump version to v0.0.2, add main-side discipline note about contract_refresh.
- Modify: `packages/manta-skill-validator/tests/integration/skills-and-commands.test.ts` (existing — Phase 0e) — assert the new skill versions parse clean.
- Modify: `docs/user/forking-realities.md` (Phase 2a) — replace the "isolation not yet enforced — Phase 2b" caveat with a forward link to `docs/internals/forking-realities-isolation.md`.

### File size sanity check

`tests/integration/forking-isolation.test.ts` projected ~280 LOC (4 boundaries × ~60 LOC + setup). `clone-spawner.ts` grows by ~6 LOC (one `env` field). `manta-as-clone/SKILL.md` grows by ~30 lines. `manta-coordinate/SKILL.md` grows by ~12 lines. `forking-realities-isolation.md` projected ~80 lines. None unwieldy.

### Tasks

- [ ] **2.1: Spawner env injection (failing test first)**

**File:** `packages/manta-cli/tests/spawner/clone-spawner.test.ts` (extend)

```ts
it('injects MANTA_BUS_PEER_SCOPE=parent-only for forking-realities clones', async () => {
  const reg = makeFakeRegistry();
  const casts = makeFakeCasts();
  let captured: Record<string, string> | undefined;
  const recordingRunner: CloneRunner = {
    run(input) {
      captured = input.env;
      return fakeCloneRunner.run(input);
    },
  };
  await spawnClone({
    repoRoot: tmpRepo,
    snapshot: makeSnapshotForTest({ cloneId: 'A', mode: 'forking-realities' }),
    worktree: `${tmpRepo}/.manta/worktrees/clone-A`,
    runner: recordingRunner,
    registry: reg.writer,
    casts: casts.creator,
    castMode: 'forking-realities',
    castPolicy: { peer_messaging: 'denied', auto_merge_threshold: null },
    castRoster: [{ clone_id: 'A', assignment: null }],
  });
  expect(captured?.MANTA_BUS_PEER_SCOPE).toBe('parent-only');
});

it('injects MANTA_BUS_PEER_SCOPE=siblings-allowed for recon-swarm clones (regression guard)', async () => {
  // Same shape as above, but mode: 'recon-swarm' → siblings-allowed.
});
```

Run: `pnpm --filter @manta/cli test -- tests/spawner/clone-spawner.test.ts`
Expected: 2 tests fail.

- [ ] **2.2: Implement spawner env injection**

**File:** `packages/manta-cli/src/spawner/clone-spawner.ts:95-104`

```diff
  const proc = opts.runner.run({
    cwd: opts.worktree,
    env: {
      MANTA_SNAPSHOT_PATH: snapshotPath,
      MANTA_REPO_ROOT: opts.repoRoot,
      MANTA_CLONE_ID: cloneId,
+     MANTA_BUS_PEER_SCOPE:
+       opts.snapshot.taskContract.mode === 'forking-realities'
+         ? 'parent-only'
+         : 'siblings-allowed',
    },
    appendSystemPrompt: buildPrimingText(opts.snapshot),
    prompt: buildInitialPrompt(opts.snapshot),
  });
```

Run: the failing tests now pass.

- [ ] **2.3: `manta-as-clone` v0.0.4 — forking-realities bullet**

**File:** `skills/manta-as-clone/SKILL.md`

Current version is **v0.0.3** (verify with `head -10 skills/manta-as-clone/SKILL.md` — last bumped in `5cd7234` for bug #9/#10). Bump to `v0.0.4`. Add a new `### Forking-realities (Sec 5.8)` section under the existing `## Forbidden` heading (or wherever the v0.0.3 forbidden-list lives):

```markdown
### Forking-realities (Sec 5.8 — plagiarism prevention)

Detect via env var: `MANTA_BUS_PEER_SCOPE === 'parent-only'`. Equivalently:
your task contract's `mode` is `forking-realities`.

When this is the case, the following Bus tools are **structurally rejected
by the bus** (you will receive a `forking_isolation` error envelope) — do not
call them at all:

- `manta.message` to a sibling clone. Allowed only with the main, but the
  main is not in the registry — you have no clone_id to address it with.
  Use `manta.broadcast` (clone → main) instead.
- `manta.task_contract.read` for any clone_id but your own. Set
  `requesting_clone_id` to your own clone_id; reading another clone's
  contract leaks their approach.
- `manta.claim_work` — work-claim is collaborative-mode only. In forking-
  realities every sibling is doing the same job; claim is conceptually
  a no-op AND reveals your existence to other tailers.

Soft-restricted (the bus will not stop you, but the skill says don't):

- Reading sibling worktrees on disk. The filesystem isn't fenced. Stay in
  your own worktree.
- Writing ZK notes that reference sibling clone_ids by name. Tag your ZK
  with `clone-{your-id}` and `cast-{cast-id}` only.

Round-table escalation (Sec 5.4) — if you and a sibling have conflicting
solutions, do **not** message the sibling; broadcast a `blocker` event
with `event_type: 'blocker'`, payload describing the disagreement. The
main pulls from broadcasts; the sibling does not.
```

This is **descriptive**, not prescriptive — it explains the bus filter so an honest clone never trips it. Per CLAUDE.md HARD RULES, skill text is a soft prior, not a hard contract; the bus filter from Chunk 1 is the hard contract.

Run the skill validator from Phase 0e:

```bash
pnpm --filter @manta/skill-validator build && \
  pnpm --filter @manta/skill-validator test
```

Expected: skill parses clean; no validator warnings.

- [ ] **2.4: `manta-coordinate` v0.0.2 — main-side contract_refresh discipline**

**File:** `skills/manta-coordinate/SKILL.md`

Bump version to `v0.0.2`. Add under main-side guidance:

```markdown
### Cast-agnostic contract_refresh (Sec 5.7)

When you broadcast a `manta.contract_refresh` it fans out to every active
clone, regardless of cast. Therefore the payload must be cast-agnostic —
do not include per-cast approach hints, per-cast scope, or per-cast
deliberations. For per-cast updates, use `manta.task_contract.write` per
clone instead. Violation is a soft information leak across casts (research
clone-C §6 "Contract refresh content").
```

Run the skill validator: same as Task 2.3.

- [ ] **2.5: End-to-end integration test (failing first)**

**File (new):** `packages/manta-cli/tests/integration/forking-isolation.test.ts`

The test spawns 2 fake forking-realities clones, then walks each Strategy 1 boundary using the in-process `BusContext` from `createBusServer({...})` so we don't have to drive the real fake-clone subprocesses through MCP. The `fake-clone.mjs` fixture from Phase 0d only needs to register and exit — the test exercises the bus directly afterwards.

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execaSync } from 'execa';
import { createBusServer } from '@manta/bus';
import { runCastCommand } from '../../src/commands/cast';
import { runFakeCloneScript } from '../../src/spawner/clone-spawner';
import { createRuntime } from '../../src/runtime';
import { fileURLToPath } from 'node:url';

const FAKE_CLONE = fileURLToPath(new URL('../fixtures/fake-clone.mjs', import.meta.url));

describe('forking-realities end-to-end isolation', () => {
  it('every Strategy 1 boundary holds across a 2-clone FR cast', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'manta-fr-iso-'));
    try {
      mkdirSync(join(repo, '.manta'));
      execaSync('git', ['init', '-q'], { cwd: repo });
      execaSync('git', ['commit', '--allow-empty', '-m', 'init', '-q'], { cwd: repo });
      const rt = await createRuntime({ repoRoot: repo });
      try {
        const result = await runCastCommand(rt, {
          mode: 'forking-realities',
          task: 'irrelevant — overridden per-clone',
          cloneCount: 2,
          cycleIntervalMs: 100,
          tickBudgetMs: 30_000,
          castId: 'cast-iso-1',
          budgetUsdPerClone: 1,
          budgetUsdPerCast: 5,
          cloneAssignments: {
            A: { task: 'algorithm-only' },
            B: { task: 'index-based' },
          },
          runner: runFakeCloneScript({ scriptPath: FAKE_CLONE }),
          reporter: { info: () => {}, warn: () => {}, error: () => {} },
          verifyMcp: false,
        });
        expect(result.exitCode).toBe(0);

        // Both clones registered and exited; we can now drive the bus
        // directly to assert the isolation boundaries. Handler factories
        // are re-exported from @manta/bus index (see Task 1.13a — done in
        // Chunk 1) so this test file imports from the package boundary
        // rather than reaching into @manta/bus internals.
        const {
          createCommunicationHandlers,
          createContractHandlers,
          createWorkHandlers,
        } = await import('@manta/bus');
        const comm = createCommunicationHandlers(rt.ctx);
        const contractH = createContractHandlers(rt.ctx);
        const workH = createWorkHandlers(rt.ctx);

        // 1. Sibling-to-sibling message rejected.
        await expect(
          comm.message({ from_clone_id: 'A', to_clone_id: 'B', payload: { exfil: 'draft' } }),
        ).rejects.toMatchObject({ name: 'BusForkingIsolationError', tool: 'manta.message' });

        // 2. Cross-clone task_contract.read rejected.
        await expect(
          contractH.read({ clone_id: 'B', requesting_clone_id: 'A' }),
        ).rejects.toMatchObject({ name: 'BusForkingIsolationError', tool: 'manta.task_contract.read' });

        // 3. Self-read still works.
        const selfA = await contractH.read({ clone_id: 'A', requesting_clone_id: 'A' });
        expect(selfA.contract.contract.task).toBe('algorithm-only');

        // 4. claim_work rejected for both clones.
        for (const id of ['A', 'B'] as const) {
          await expect(
            workH.claim({ clone_id: id, item: 'task-x', timeout_ms: 60_000 }),
          ).rejects.toMatchObject({ name: 'BusForkingIsolationError', tool: 'manta.claim_work' });
        }

        // 5. Broadcast event payload has cast_id + cast_mode stamped.
        const evt = await comm.broadcast({
          clone_id: 'A',
          event_type: 'breakthrough',
          payload: { what: 'something' },
        });
        expect(evt.event.payload).toMatchObject({
          cast_id: 'cast-iso-1',
          cast_mode: 'forking-realities',
        });
      } finally {
        await rt.dispose();
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
```

Run: `pnpm --filter @manta/cli test -- tests/integration/forking-isolation.test.ts`
Expected: green (everything from Chunk 1 plus the spawner env injection from Tasks 2.1-2.2 wires up).

- [ ] **2.6: Internal closed-set isolation table**

**File (new):** `docs/internals/forking-realities-isolation.md`

A closed-set table mapping every of the 18 MCP tools to its forking-realities status. Format:

```markdown
# Forking-realities Bus tool allow/reject table

Per spec Sec 5.8 + Phase 2b enforcement. Closed set — every Bus tool is
either allow-listed or reject-listed below; an unlisted tool is a plan
gap. Cross-reference: `packages/manta-bus/src/server.ts` tool table at
lines ~115-224.

| Tool                          | recon-swarm | forking-realities          | Enforcement layer                |
|-------------------------------|-------------|----------------------------|----------------------------------|
| manta.register                | allow       | allow (cast_id required)   | RegisterInputSchema.refine       |
| manta.heartbeat               | allow       | allow                      | n/a                              |
| manta.suicide_intent          | allow       | allow                      | n/a                              |
| manta.report_death            | allow       | allow                      | n/a                              |
| manta.task_contract.read      | allow       | allow self only            | crossCloneRead helper            |
| manta.task_contract.write     | allow       | allow (spawner-only)       | n/a                              |
| manta.ack_contract            | allow       | allow                      | n/a                              |
| manta.contract_refresh        | allow       | allow (main-only by shape) | schema (no clone_id field)       |
| manta.claim_work              | allow       | reject                     | claim_work handler               |
| manta.release_work            | allow       | allow (no plagiarism risk) | n/a                              |
| manta.lock                    | allow       | allow (soft-leak — see #X) | manta-bugs known limitation      |
| manta.unlock                  | allow       | allow                      | n/a                              |
| manta.renew_lock              | allow       | allow                      | n/a                              |
| manta.broadcast               | allow       | allow (cast_id-stamped)    | communication handler            |
| manta.message                 | allow       | reject sibling             | siblingsInSameForkingCast helper |
| manta.drift_report            | allow       | allow                      | n/a                              |
| manta.zk_write                | allow       | allow (skill-restricted)   | manta-as-clone v0.0.3            |
| manta.para_append             | allow       | allow (skill-restricted)   | manta-as-clone v0.0.3            |
```

Plus: known limitations section (lock owner-id leak, filesystem siblings) + forward-pointer to Phase 5+ PreToolUse hooks.

- [ ] **2.7: Update `docs/user/forking-realities.md`**

**File:** `docs/user/forking-realities.md` (created in Phase 2a)

Replace the "Phase 2b will enforce — for now sibling messaging is recorded but not blocked" caveat with:

```markdown
## Sibling isolation

Forking-realities clones cannot exchange work-in-progress through the Bus.
The bus rejects sibling-to-sibling `manta.message` and cross-clone
`manta.task_contract.read`; `manta.claim_work` is rejected entirely for
forking-realities clones (no shared work board in this mode).

For the closed-set allow/reject table, see
[docs/internals/forking-realities-isolation.md](../internals/forking-realities-isolation.md).

Known limitations (Phase 2b):
- Lock owner-id leak on shared-path contention. Spec Sec 5.7 PreToolUse
  hooks land in Phase 5+; until then, skill discipline is the primary
  defense.
- Filesystem-level isolation is skill-only. A clone could `cd ../clone-B`
  if it ignored skill discipline. Phase 5+ may add filesystem hooks.
```

- [ ] **2.8: Whole-workspace sweep + lint**

```bash
pnpm -r build && pnpm -r test && pnpm -r lint
```

Expected: green; no lint warnings; coverage thresholds met.

- [ ] **2.9: Commit Chunk 2**

```bash
git add packages/manta-cli/src/spawner/clone-spawner.ts \
        packages/manta-cli/tests/spawner/clone-spawner.test.ts \
        packages/manta-cli/tests/integration/forking-isolation.test.ts \
        skills/manta-as-clone/SKILL.md \
        skills/manta-coordinate/SKILL.md \
        docs/user/forking-realities.md \
        docs/internals/forking-realities-isolation.md

# CLAUDE.md HARD RULE: take author from `git log`. Use a tab separator
# because author names contain spaces ("Tim Hunt") and ${VAR% *} would
# strip the wrong token.
EMAIL="$(git log -1 --format='%ae')"
NAME="$(git log -1 --format='%an')"
git -c user.email="$EMAIL" -c user.name="$NAME" commit -m "$(cat <<'EOF'
feat(phase-2b): forking-realities skill discipline + spawner env + e2e

Strategy 2 — soft prior reinforcing the bus-side hard rejects from Chunk 1:

* Spawner injects MANTA_BUS_PEER_SCOPE=parent-only for FR clones;
  siblings-allowed otherwise. Skill text references the env var so an
  honest clone never trips the bus filter.
* manta-as-clone v0.0.3 — new ### Forking-realities (Sec 5.8) section
  enumerating the four rejected tools + soft-restricted file/ZK rules +
  round-table escalation discipline.
* manta-coordinate v0.0.2 — main-side note: contract_refresh payloads
  must be cast-agnostic (research clone-C §6).
* End-to-end integration test in @manta/cli — spawns 2 fake FR clones
  and walks every Strategy 1 boundary (4 reject checks + 1 self-allow +
  1 broadcast cast_id-stamp assertion).
* docs/internals/forking-realities-isolation.md — closed-set table of
  all 18 Bus tools with allow/reject status and enforcement layer.
* docs/user/forking-realities.md — Phase 2a's "isolation not yet
  enforced" caveat replaced with a forward link to the internal doc and
  a known-limitations section (lock owner-id leak, filesystem-level
  isolation deferred).

Phase 2b (Strategy 1 + Strategy 2) closes spec Sec 5.8 with: 1 schema
refine, 1 error class + envelope mapping, 1 helper module, 4 handler
edits, 1 spawner env field, 2 skill version bumps, 1 internal doc, 1 e2e
test. Belt-and-braces: bus filter is hard (Chunk 1); skill text is the
explainable safety net (Chunk 2). No false sense of security: filesystem
+ lock owner-id leaks are documented as known Phase 2b limitations.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Verify: `git log --oneline -2` shows both Phase 2b chunk commits.

---

## Acceptance criteria (Phase 2b-level — feeds INDEX.md)

- A `forking-realities` cast spawns; sibling A's `manta.message` to B is rejected with `forking_isolation` envelope (`tool: 'manta.message'`).
- Sibling A's `manta.task_contract.read({ clone_id: 'B', requesting_clone_id: 'A' })` is rejected.
- Sibling A's `manta.claim_work` is rejected.
- Sibling A's `manta.broadcast` event payload contains `cast_id` and `cast_mode`.
- A `recon-swarm` cast still works with no behavioural change for any of the four boundaries above.
- A forking-realities `manta.register` without `metadata.cast_id` fails parse-time validation.
- `MANTA_BUS_PEER_SCOPE=parent-only` env present in forking-realities clone process; `siblings-allowed` for recon-swarm.
- `manta-as-clone` v0.0.3 + `manta-coordinate` v0.0.2 parse clean against `@manta/skill-validator`.
- `docs/internals/forking-realities-isolation.md` enumerates every of the 18 Bus tools — no holes, no spec drift.
- Whole-workspace sweep green; coverage ≥ 80 % on every new file.
- Plan reviewer subagent approved both chunks before they executed.

---

## Risks called out for the reviewer

1. **`requesting_clone_id` is operator-trusted.** A malicious clone can lie about its own clone_id. Until Phase 5 daemon-mode plumbs per-connection identity, this is best-effort defense-in-depth, NOT a hard guarantee. The plan + the user-doc explicitly call this out; the implementation must not pretend otherwise.
2. **Lock owner-id leak.** `BusLockedError.ownerCloneId` reveals who holds a lock on a contended path. In forking-realities each clone has its own worktree so collisions are rare, but an aggressive clone could lock a parent-repo path to probe siblings. Phase 5+ scope-relative-lock-path hardening is the durable fix; Phase 2b accepts the soft leak with a `manta-bugs.md` entry. Plan does NOT pretend to fix this.
3. **Filesystem-level access.** A skill-violating clone could `cd ../clone-B && cat`. Skill discipline is the only Phase 2b defense; Phase 5+ filesystem hooks are the durable fix. Plan does NOT pretend to fix this.
4. **`forking_isolation_attempt` is a new event-log type.** `BusEvent.type` at `state/events.ts:10` is an open `string` (not a `z.enum`), so no schema widening required. The risk reduces to: downstream consumers that switch on `event.type` must have a `default:` branch or tolerate unknown values. Task 1.10 instructs to grep for closed-set assertions; if any caller asserts only known types, it must be widened or the test must be updated.
5. **Skill text is a soft prior, not a hard contract** (CLAUDE.md HARD RULES). The bus filter is the hard contract. Plan respects this discipline: every Strategy 2 edit references its Strategy 1 enforcement counterpart.
6. **Cross-cast messaging is allowed (research §6).** Two forking-realities clones in *different* casts can `manta.message` each other — bizarre but not a Sec 5.8 violation. Test 1.7 case 3 pins this; do not weaken it.
7. **Manifest-driven policy in Phase 4+.** Helper currently joins on `cast_mode === 'forking-realities'`. When more modes need partial-isolation policies (council, decoy), the helper swaps to `ctx.casts.read(cast_id).policy.peer_messaging === 'denied'`. Call sites stay the same; helper changes.
