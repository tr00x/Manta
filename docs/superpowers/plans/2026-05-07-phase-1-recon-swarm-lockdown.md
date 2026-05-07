# Phase 1 — `recon-swarm` Production-Grade Lockdown Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close `docs/manta-bugs.md` bugs **#2** (spawner-registers-clone claim is misleading), **#3** (e2e cast hangs against real `claude --print`; clones never register), and **#4** (`claude --print --snapshot <path>` silently accepts the unknown flag), so the Phase-0 acceptance e2e cast (`MANTA_E2E=1 pnpm e2e:recon-swarm`) goes green against the real `claude` binary and `docs/acceptance/phase-0.md` can be signed off. After this plan: a developer can clone the repo, follow `docs/user/getting-started.md`, run `manta cast recon-swarm`, and watch real Claude Code clones produce a unified codebase map within the cast TTL — no manual recovery, no harness hangs, no missing registry entries.

**Architecture:** No new TypeScript packages. This phase ships **mechanical** fixes — the Phase-0 design is sound, the wiring is incomplete. Three coupled changes inside `@manta/cli`:

1. **Spawner pre-registers the clone.** Before `runner.run(...)` returns, the spawner awaits `runtime.ctx.registry.register({ clone_id, mode, parent_pid, worktree, metadata })`. The Bus `Registry` (see `packages/manta-bus/src/state/registry.ts`) hardcodes `state: 'STARTING'` and stamps `registered_at = last_heartbeat_at = clock.now()`; we don't pass either. When the clone's first MCP `manta.heartbeat` lands, the record already exists, so the heartbeat transitions `state: STARTING → WORKING` and updates `last_heartbeat_at`. Closes bug #2 (the `manta-as-clone` skill text becomes accurate, not misleading).
2. **Replace the bogus `--snapshot <path>` flag with a real `claude` CLI transport.** The current `runClaudeCli` builds `['--print', ...extraArgs, '--snapshot', snapshotPath]`. The `claude` binary (≥ 2.1.132) has no such flag and silently swallows unknown flags. We switch to `--append-system-prompt <text>` (verified by `claude --help` and the positive smoke in task 1.2) carrying a fixed Manta priming preamble that instructs the clone to load the `manta-as-clone` skill, read `MANTA_SNAPSHOT_PATH`, ack the contract, and start work. The snapshot path is already exported as `MANTA_SNAPSHOT_PATH` env var (clone-spawner.ts:58). The initial task prompt is supplied as the trailing positional argv. We also pass `--permission-mode bypassPermissions` (NOT `auto` — `auto` is the interactive classifier mode that blocks waiting for human y/n; `bypassPermissions` is the only non-blocking choice for `--print`-driven autonomous clones). Closes bugs #3 and #4.
3. **Behavioural-fixture test of the spawn → register → first-heartbeat sequence.** A new integration test under `packages/manta-cli/tests/spawner/startup-sequence.test.ts` that wires the real `Registry` (built via `createRuntime` — there is **no** `createBus` factory in `@manta/bus`'s public exports) and a fake-clone runner, then asserts: (a) `registry.get(clone_id)` resolves with `state: 'STARTING'` *immediately after* `spawnClone` resolves and *before* the runner exits; (b) `register` is `await`ed *before* `runner.run` is called (proven by a slow-register test that interleaves event ordering); (c) the priming text passed to the runner contains the `manta-as-clone` skill name and points at `MANTA_SNAPSHOT_PATH` and does NOT contain `--snapshot`; (d) on a successful e2e heartbeat, `state` transitions away from `STARTING` (this is the real liveness signal — `last_heartbeat_at` is non-zero from the moment of register, so it cannot be used as the "clone is alive" proof; only the state transition can). This is the acceptance-blocking signal Phase 0e/0f preflights missed.

In addition: small, scope-limited collateral updates to keep skill text, slash-command text, user docs, and the e2e test in sync with the new transport. The Open Questions from the plan-review (re-run with same castId, snapshot orphans on register failure) are handled by explicit tasks below.

**Tech Stack:** TypeScript 5.x strict, vitest, Node 20+, real `claude` CLI behind the existing env-gated e2e package. No new runtime deps. No new packages.

**Non-goals for Phase 1:**
- Distributing as a Claude Code plugin (`npx manta@latest install`) — Phase 7.
- New `recon-swarm`-adjacent commands (`dry-run`, `inspect`, `tail`) — separate Phase-1 sub-plan if/when needed; the lockdown does not block them.
- PreToolUse hooks for `forbidden_paths` enforcement — Phase 3 fragility-strikes track. Today, scope is enforced by skill discipline only.
- Any work on `forking-realities`, `bug-hunt`, `refactor-wave` modes — Phase 2+.
- Cost/coverage instrumentation beyond what is already in place — Phase 11.0+ observability tier 4.
- Charge system, daily caps beyond per-cast budgets — Phase 3.
- Cross-mode E2E (only `recon-swarm` is in scope for Phase-1 acceptance).
- Exposing `--permission-mode` as a `manta cast` flag — Phase 2+ if user demand surfaces; until then, hardcoded `bypassPermissions` with a `// Reason:` comment per CLAUDE.md.

**Quality bar (CLAUDE.md / spec Sec 14):**
- `pnpm -r --workspace-concurrency=1 test` green; whole-repo unit suite remains 313+ tests passing.
- `@manta/cli` coverage stays ≥ 80% statement / ≥ 80% branch (currently 95.96% statement). The new pre-register helper, transport-builder, and behavioural fixture are all covered by targeted tests.
- `MANTA_E2E=1 pnpm e2e:recon-swarm` is green against real `claude --print`. The e2e test additionally asserts a **positive** event-timeline signal (each clone's `state` transitions away from `STARTING` within `cast_timeout_seconds / 4` of spawn) on top of the existing final-state assertions, so a wedged clone fails fast instead of timing out at 30 minutes.
- `docs/manta-bugs.md` records bugs #2/#3/#4 as `Fixed in <commit-sha-or-TBD>` (commit-sha policy below) with the post-mortem path; `docs/acceptance/phase-0.md` checkboxes are re-evaluated row-by-row and the GA gate is unblocked (or, if a new issue surfaces during dogfood, it is logged with the same rigour).
- Skill validator clean: `node packages/manta-skill-validator/dist/bin/manta-validate-skills.cjs --root .` exits 0 with `0 error(s), 0 warning(s)`.
- Lint clean (`pnpm -r lint` zero warnings); typecheck clean (`pnpm -r typecheck`).
- One atomic commit (Chunk 1) — conventional-commit format. Commit-sha placeholder policy: docs that reference "the Phase-1 fix commit sha" use the literal string `<commit-pending>` until the commit lands; the same commit fixes its own placeholders. We do NOT use `git commit --amend` to back-fill (CLAUDE.md prohibits amend); instead, the commit message embeds the exact placeholder strings, and a one-line follow-up commit (`docs(phase-1): fill commit-sha references`) replaces them once the SHA is known. Both commits are part of this plan's tickoff.
- A post-mortem `docs/post-mortems/2026-05-07-phase-1-lockdown-cast.md` documents the e2e cast (cast-id, observed timeline `mm:ss` format, cost in `$X.XX`, surprises, skill drift). This is the dogfood signal Phase 1 owes the spec.

**Reference docs:**
- Predecessor plans: `phase-0-foundation.md`, `phase-0b-bus.md`, `phase-0c-orchestrator.md`, `phase-0d-cli.md`, `phase-0e-skills-and-commands.md`, `phase-0f-recon-swarm-integration.md` (all Executed).
- Source-of-truth design: `docs/superpowers/specs/2026-05-06-manta-pattern-design.md` — Sec 3 (clone lifecycle: CAST → LIVE → HALF-LIFE → TERMINATE → COOLDOWN), Sec 4 (Manta Bus & file locks), Sec 9 (Реальные блокеры самого Claude Code — particularly point 1 about `--print` being one-shot), Sec 14 (Production Quality Standards), Sec 15 (Bootstrap Strategy — Phase 1 is the last solo-built phase before clones can build clones).
- Live bug log: `docs/manta-bugs.md` entries #2 / #3 / #4.
- Plan-review report (in-conversation): the 14 must-fix items + 10 advisories that informed this plan's revision.

**Key spec hooks this plan honours:**
- Sec 3 step 4 ("Bus join — клон регистрируется в Manta Bus") — Russian passive ("регистрируется") is interpretation-agnostic. We pick spawner-side pre-registration because it removes the start-up race window where the orchestrator's heartbeat-deadline can fire before the clone process has finished booting.
- Sec 4 lifecycle API — `manta.register` remains the canonical creation path for the MCP-exposed surface. The spawner uses the same in-process `Registry.register` the MCP `manta.register` tool wraps; we are not adding a side-channel.
- Sec 9 point 1 ("Headless spawn ограничен — `--print` это one-shot, multi-step через CLI хрупко. → V1: batch-spawn (one-shot per клон). Хорошо работает для recon-swarm") — `recon-swarm` is exactly the mode designed to live with `--print`'s one-shot model. The priming preamble + initial task prompt is a single round-trip; no multi-step CLI orchestration is required.

**API contracts (cited from real source — copy-paste-faithful, no drift):**
- `Registry.register(input: RegisterInput)` — `RegisterInput = { clone_id: string; mode: Mode; parent_pid: number; worktree: string; metadata: Record<string,string> }` (see `packages/manta-bus/src/schema.ts:27-35`). Returns `Promise<CloneRecord>`. Throws `BusConflictError` if `clone_id` already exists. Stamps `registered_at = last_heartbeat_at = clock.now()`, forces `state: 'STARTING'`. Source: `packages/manta-bus/src/state/registry.ts:31-58`.
- `Registry.get(cloneId: string): Promise<CloneRecord>` — throws `BusNotFoundError` if absent. **Does NOT return null.** Source: `registry.ts:116-121`.
- `Registry.markDead(cloneId, reason): Promise<CloneRecord>` — throws `BusNotFoundError` if not registered. Source: `registry.ts:96-114`.
- `Registry.list(): Promise<CloneRecord[]>` — `CloneRecord` has snake_case fields: `clone_id`, `mode`, `parent_pid`, `worktree`, `metadata`, `registered_at`, `last_heartbeat_at`, `state`, `progress?`, `death_reason?`, `died_at?`. Source: `registry.ts:7-19`.
- `CloneState = 'STARTING' | 'WORKING' | 'BLOCKED' | 'WINDING_DOWN' | 'DEAD'` (uppercase). Source: `packages/manta-bus/src/schema.ts:25`.
- `Runtime` shape: `{ repoRoot, ctx: BusContext, orchestrator: Orchestrator, thresholds, dispose }`. The Bus is exposed as **`runtime.ctx`**, not `runtime.bus`. Source: `packages/manta-cli/src/runtime.ts:31-37`.
- `BusContext.registry: Registry`. Reach via `runtime.ctx.registry`. Source: `runtime.ts:63-72`.
- There is **no** `createBus` factory exported from `@manta/bus`. Use `createRuntime({ repoRoot, thresholdOverrides? })` from `@manta/cli/runtime.ts` to get an assembled `BusContext` + `Orchestrator`. Source: `packages/manta-bus/src/index.ts` (no `createBus` export).
- `Snapshot` fields are camelCase per Phase 0 fix: `castId`, `taskContract.cloneId`, `taskContract.mode`, `taskContract.task`, `taskContract.scope.{allowedPaths,forbiddenPaths,maxFilesChanged}`. Source: `packages/manta-snapshot/src/schema.ts:25-82`. Use `buildCloneSnapshot({...})` from `packages/manta-cli/src/spawner/snapshot-builder.ts` to construct test snapshots — do NOT hand-roll partial fixtures.

---

## Chunks

1. **Chunk 1 — Lockdown** — pre-register from spawner, replace `--snapshot` transport with real `claude` CLI flags, helper fixtures, behavioural-fixture test, e2e timeline assertion, skill+slash-command+doc text alignment, dogfood + bug-log + acceptance updates, post-mortem.

(Single chunk; the changes are tightly coupled — splitting them would force ordering hacks. Total LOC budget ≤ ~1500 lines across plan + impl + tests + docs.)

---

## Chunk 1: Lockdown — pre-register, real transport, behavioural fixture, dogfood

**Goal of this chunk:** When this chunk lands, `MANTA_E2E=1 pnpm e2e:recon-swarm` produces a real codebase-map output from real clones, the registry shows DEAD entries with valid post-mortems, the e2e-timeline assertion fires a positive signal, and Phase-0 acceptance can be re-walked end-to-end without harness intervention.

**Files (new):**
- Create: `packages/manta-cli/src/spawner/priming.ts` — pure builder for the `--append-system-prompt` priming text and the initial task prompt.
- Create: `packages/manta-cli/tests/helpers/registryFake.ts` — `makeRegistryFake({ onRegister?, onMarkDead? })` returning an in-memory object that implements the narrow `RegistryWriter` interface plus a `records: CloneRecord[]` array.
- Create: `packages/manta-cli/tests/helpers/snapshotFixture.ts` — `makeSnapshotFor({ cloneId, castId?, mode?, task?, scope? })` thin wrapper over `buildCloneSnapshot` with sensible defaults so individual tests don't repeat 11 args.
- Create: `packages/manta-cli/tests/spawner/priming.test.ts` — unit tests on `priming.ts`.
- Create: `packages/manta-cli/tests/spawner/pre-register.test.ts` — unit tests on the pre-register path.
- Create: `packages/manta-cli/tests/spawner/startup-sequence.test.ts` — behavioural fixture for spawn → register → state-transition (the gap Phase 0 e2e missed).
- Create: `docs/post-mortems/2026-05-07-phase-1-lockdown-cast.md` — written *after* the dogfood cast in step 1.21, before the chunk's atomic commit.

**Files (modified):**
- Modify: `packages/manta-cli/src/errors.ts` — add `'register_failed'` to the `CliError.kind` enum.
- Modify: `packages/manta-cli/src/spawner/clone-spawner.ts` — add narrow `RegistryWriter` interface; extend `SpawnCloneOptions` with `registry: RegistryWriter`; extend `CloneRunnerInput` to add `appendSystemPrompt: string` and `prompt: string`, REMOVE `snapshotPath` from the **input** type only (it stays on `CloneHandle` because tests consume `handle.snapshotPath`); pre-register the clone via `await opts.registry.register({ clone_id, mode, parent_pid, worktree, metadata })` *before* `runner.run(...)`; rebuild `runClaudeCli` argv to `['--print', ...(opts.extraArgs ?? []), '--append-system-prompt', input.appendSystemPrompt, '--permission-mode', 'bypassPermissions', input.prompt]`.
- Modify: `packages/manta-cli/src/runtime.ts` — no functional change; the `ctx.registry` is already exposed. Add a one-line JSDoc on `Runtime.ctx` clarifying the `runtime.ctx.registry` access pattern for spawner consumers.
- Modify: `packages/manta-cli/src/commands/cast.ts` — feed `runtime.ctx.registry` into `spawnClone`; build `appendSystemPrompt` via `buildPrimingText(snapshot)` and `prompt` via `buildInitialPrompt(snapshot)`; on cast-failure teardown, only call `markDead` for clones that successfully pre-registered (track via a per-clone `wasRegistered` flag set on spawnClone-resolved). Document why pre-register sits AFTER `contracts.write` but BEFORE `runner.run` (so the orchestrator can read the contract on the first cycle even if register is moments earlier).
- Modify: `packages/manta-cli/tests/spawner/clone-spawner.test.ts` — every `spawnClone({...})` call gets `registry: makeRegistryFake()`; argv assertions flip from `--snapshot` to `--append-system-prompt`; add explicit `expect(argv).not.toContain('--snapshot')` and `expect(argv).not.toContain('--strict-mcp-config')` regression assertions.
- Modify: `packages/manta-cli/tests/integration.test.ts` — pass `runtime.ctx.registry` through to `spawnClone` (the integration path); assert pre-register invariant survives the integration path; remove any old `--snapshot` expectation.
- Modify: `skills/manta-as-clone/SKILL.md` — add a `## Startup sequence` H2 right after `## Allowed`, before `## Forbidden`. The new section uses `clone_id` (snake_case) consistent with on-the-wire `manta.heartbeat` calls. Existing line "The CLI spawner registered you on the bus before launching this process" stays — it is now accurate.
- Modify: `commands/cast.md` — replace the production line `claude --print --snapshot <path>` with `claude --print --append-system-prompt <priming-text> --permission-mode bypassPermissions <initial-prompt>` (verbatim — this file is user-readable slash-command documentation and must match reality).
- Modify: `docs/user/recon-swarm.md` — replace the (now-vestigial) "the spawner registered the clone *before* the process started" bullet with one that points at the behavioural fixture (`packages/manta-cli/tests/spawner/startup-sequence.test.ts`) as proof.
- Modify: `docs/user/getting-started.md` — add a "Troubleshooting: clone process started but never heartbeats" callout listing the env vars (`MANTA_SNAPSHOT_PATH`, `MANTA_REPO_ROOT`, `MANTA_CLONE_ID`) and the priming-text mechanism.
- Modify: `packages/manta-e2e/tests/recon-swarm.e2e.test.ts` — add **positive timeline assertions**: each clone's `state` transitions away from `'STARTING'` within `cast_timeout_seconds / 4` of spawn (a real heartbeat moves state to `'WORKING'`/`'BLOCKED'`/etc.; `last_heartbeat_at` cannot be used because it is non-zero from register). Derive `expectedCloneCount` from the CLI args the test passes (`--clones 2`).
- Modify: `docs/manta-bugs.md` — flip bugs #2/#3/#4 from `Open` to `Fixed in <commit-pending>`, link to the post-mortem and the relevant test files. Move all three from "Open bugs" to "Fixed bugs". (Follow-up commit fills `<commit-pending>` with real SHA — see policy above.)
- Modify: `docs/acceptance/phase-0.md` — re-tick **each** of the BLOCKED rows in the e2e block (lines ~42-48 per the current state), not just one. Add a link to the dogfood post-mortem and cast-id. Leave the human sign-off line at the bottom unchecked.
- Modify: `docs/superpowers/plans/INDEX.md` — add the Phase-1 row under a new `## Phase 1` heading; mark it `Approved — ready to execute` after the plan-review checkpoint passes; flip to `Executed` after Chunk 1 commits.

**Why these boundaries:**
- The spawner already exposes a `CloneRunner` seam (`runClaudeCli` is the production runner; `runFakeCloneScript` is the test runner). We add a parallel `RegistryWriter` seam so unit tests can exercise pre-registration without spinning up the full Bus. The integration test exercises the real Bus.
- The priming-text builder is pure and lives in its own file (`priming.ts`) so its content can be diffed cleanly across versions; if the priming wording changes, the unit test catches the diff.
- The behavioural fixture has its own test file because it tests a *sequence* (an ordered series of side effects), not a single function. Mixing it with `clone-spawner.test.ts` would muddy the unit-vs-sequence semantics.
- We do **not** rewrite the existing `--snapshot` removal as a backwards-compat shim. There are no consumers of `--snapshot` outside of this CLI; one-call-site change.
- Skill text edit is *additive* (new H2 only, no removal), to preserve the validator-clean signal and avoid touching text the user has already reviewed.

### Tasks

- [ ] **1.1: Verify Phase 0f shipped clean baseline**

Run from repo root:
```bash
pnpm -r --workspace-concurrency=1 test
```
Expected: 313+ tests pass across the 6 packages. If anything red: STOP. The lockdown plan is layered on top of a green Phase-0 stack; do not pretend Phase 0 was clean if it wasn't.

Run:
```bash
node packages/manta-skill-validator/dist/bin/manta-validate-skills.cjs --root .
```
Expected: `9 file(s), 0 error(s), 0 warning(s)`; exit 0.

If clean, proceed.

- [ ] **1.2: Probe `claude` CLI surface and verify the priming flag is real**

Run:
```bash
claude --version
claude --help | grep -E -- '--append-system-prompt|--permission-mode|--mcp-config|--print'
```
Expected: version ≥ 2.1.132, all four flags listed.

Run a positive smoke (verifies the priming surface actually works, not silently-ignored like `--snapshot` was — the bug-#4 lesson):
```bash
claude --print --append-system-prompt "REPLY_TOKEN=manta-phase-1-probe" --permission-mode bypassPermissions "Print only the value of REPLY_TOKEN, nothing else."
```
(NB: no `2>/dev/null` — we want CLI warnings visible, not masked.)

Expected: stdout contains the literal string `manta-phase-1-probe`. If not: STOP and re-design before writing code.

Note: `--permission-mode auto` would block on classifier-uncertain tools (the auto-mode-classifier waits for human y/n) — wrong default for `--print`-driven autonomous clones. We use `bypassPermissions` because it's the only non-interactive option that lets a `--print` session call the full tool surface. Document the observed `claude --version` in the post-mortem (step 1.22).

- [ ] **1.3: Add `'register_failed'` to `CliError.kind`**

Modify `packages/manta-cli/src/errors.ts`:
- Locate the union type for `CliError.kind` (it currently includes `'invalid_input'`, `'spawn_failed'`, `'budget_exceeded'`, etc. — confirm exact list before editing).
- Add `'register_failed'` to the union.

Run: `pnpm --filter @manta/cli typecheck`
Expected: green.

- [ ] **1.4: Failing test — spawner-priming text builder**

Create `packages/manta-cli/tests/spawner/priming.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildPrimingText, buildInitialPrompt } from '../../src/spawner/priming.js';
import { makeSnapshotFor } from '../helpers/snapshotFixture.js';

describe('buildPrimingText', () => {
  const snap = makeSnapshotFor({ cloneId: 'clone-A', castId: 'cast-X', mode: 'recon-swarm', task: 'map auth/* and billing/*' });

  it('embeds the manta-as-clone skill name', () => {
    expect(buildPrimingText(snap)).toContain('manta-as-clone');
  });
  it('embeds the clone_id (snake_case, on-the-wire form)', () => {
    expect(buildPrimingText(snap)).toContain('clone-A');
  });
  it('does NOT contain the dead `--snapshot` flag', () => {
    expect(buildPrimingText(snap)).not.toMatch(/--snapshot/);
  });
  it('points at MANTA_SNAPSHOT_PATH for the snapshot location', () => {
    expect(buildPrimingText(snap)).toContain('MANTA_SNAPSHOT_PATH');
  });
  it('instructs the clone to call manta.heartbeat first, before any mutating tool', () => {
    const text = buildPrimingText(snap);
    const heartbeatPos = text.indexOf('manta.heartbeat');
    const editPos = text.indexOf('Edit');
    expect(heartbeatPos).toBeGreaterThanOrEqual(0);
    expect(heartbeatPos).toBeLessThan(editPos === -1 ? Infinity : editPos);
  });
  it('fits under 4 KiB so argv length is never a concern', () => {
    expect(buildPrimingText(snap).length).toBeLessThan(4096);
  });
});

describe('buildInitialPrompt', () => {
  const snap = makeSnapshotFor({ cloneId: 'clone-A', task: 'map auth/* and billing/*' });
  it('includes the task description verbatim', () => {
    expect(buildInitialPrompt(snap)).toContain('map auth/* and billing/*');
  });
  it('does not embed the full snapshot inline (must reference env var)', () => {
    expect(buildInitialPrompt(snap).length).toBeLessThan(2_000);
  });
});
```

Run: `pnpm --filter @manta/cli test`
Expected: import resolution fails (file/helpers not yet created). Red light. Good.

- [ ] **1.5: Implement `tests/helpers/snapshotFixture.ts`**

Create `packages/manta-cli/tests/helpers/snapshotFixture.ts`:

```ts
import { buildCloneSnapshot } from '../../src/spawner/snapshot-builder.js';
import type { Snapshot } from '@manta/snapshot';
import type { Mode } from '@manta/bus';

export interface SnapshotFor {
  cloneId: string;
  castId?: string;
  mode?: Mode; // import the real union, do not narrow to a hand-picked subset
  task?: string;
  scope?: { allowedPaths?: string[]; forbiddenPaths?: string[]; maxFilesChanged?: number };
  siblingClones?: string[];
  deadlineMs?: number; // matches buildCloneSnapshot's parameter name (NOT seconds)
  budgetUsd?: number;
}

export function makeSnapshotFor(opts: SnapshotFor): Snapshot {
  // buildCloneSnapshot is the canonical builder used by cast.ts; using it
  // here guarantees the fixture stays in lockstep with the schema as it
  // evolves. Hand-rolled `as Snapshot` literals are the historical class-#1
  // drift bug — do not reintroduce them.
  return buildCloneSnapshot({
    cloneId: opts.cloneId,
    mode: opts.mode ?? 'recon-swarm',
    task: opts.task ?? 'unspecified',
    scope: {
      allowedPaths: opts.scope?.allowedPaths ?? ['.'],
      forbiddenPaths: opts.scope?.forbiddenPaths ?? ['.manta/state', 'secrets/'],
      maxFilesChanged: opts.scope?.maxFilesChanged ?? 0,
    },
    siblingClones: opts.siblingClones ?? [],
    deadlineMs: opts.deadlineMs ?? 60_000,
    parentWorktree: '/tmp/parent',
    cloneWorktree: '/tmp/clone',
    parentPid: process.pid,
    parentSessionId: opts.castId ?? 'cast-test',
    castId: opts.castId ?? 'cast-test',
    budgetUsd: opts.budgetUsd ?? 5,
  });
}
```

(NB: implementer must verify `buildCloneSnapshot`'s exact param list at `packages/manta-cli/src/spawner/snapshot-builder.ts` before committing. The mapping above reflects the round-2 reviewer's read; if any field has been renamed since, propagate the rename — do not invent fallbacks.)

Run: `pnpm --filter @manta/cli test packages/manta-cli/tests/spawner/priming.test.ts`
Expected: still red — `priming.ts` not yet created — but no longer the helper-import error.

- [ ] **1.6: Implement `priming.ts`**

Create `packages/manta-cli/src/spawner/priming.ts`:

```ts
import type { Snapshot } from '@manta/snapshot';

const PRIMING_TEMPLATE = `\
You are a Manta clone (illusion of the main agent). Identity: clone_id={CLONE_ID}, cast_id={CAST_ID}, mode={MODE}.

Startup sequence — do these in order, before any tool that mutates files (Read, Edit, Write):
1. Use the Skill tool to load \`manta-as-clone\`.
2. Read your snapshot from the path in env var \`MANTA_SNAPSHOT_PATH\` (it is a JSON file containing taskContract, scope, siblingClones, deadline, plus reference state). The CLI spawner has already created your registry record on the Bus.
3. Call \`manta.heartbeat\` with { clone_id: "{CLONE_ID}", state: "WORKING" }. If it errors with \`not_found\`, abort — your spawner did not pre-register; do not try to self-register (Phase 0 design forbids it; see the manta-as-clone skill).
4. Call \`manta.task_contract.read\` with your clone_id and \`manta.ack_contract\` with a one-sentence interpretation of the contract.
5. Begin the work described in the user prompt below, staying inside taskContract.scope.allowedPaths and outside taskContract.scope.forbiddenPaths (which always includes \`.manta/state\` and \`secrets/\`).

When done — even on failure — invoke the \`manta-graceful-death\` skill and exit. Do not print the final report directly; the post-mortem path is your output channel.

Forbidden in this phase: recursive \`/manta cast\`, edits outside scope, direct user contact, quiet writes to \`.manta/state/*\`.
`;

export function buildPrimingText(snapshot: Snapshot): string {
  return PRIMING_TEMPLATE
    .replaceAll('{CLONE_ID}', snapshot.taskContract.cloneId)
    .replaceAll('{CAST_ID}', snapshot.castId)
    .replaceAll('{MODE}', snapshot.taskContract.mode);
}

export function buildInitialPrompt(snapshot: Snapshot): string {
  return `Task: ${snapshot.taskContract.task}\n\nProceed per the startup sequence in your system prompt.`;
}
```

(`String.prototype.replaceAll` is standard from Node 15+; this repo's `engines.node` is 20+. No regex escaping needed.)

Run: `pnpm --filter @manta/cli test packages/manta-cli/tests/spawner/priming.test.ts`
Expected: green.

- [ ] **1.7: Implement `tests/helpers/registryFake.ts`**

Create `packages/manta-cli/tests/helpers/registryFake.ts`:

```ts
import type { CloneRecord, RegisterInput } from '@manta/bus';
// (Both types are re-exported from `@manta/bus` via `export * from './schema'`
//  in src/index.ts:3. There is NO `@manta/bus/schema` subpath — `package.json`
//  only maps the root entry. Do not invent one.)

export interface RegistryFake {
  records: CloneRecord[];
  register(input: RegisterInput): Promise<CloneRecord>;
  markDead(cloneId: string, reason: string): Promise<CloneRecord>;
  get(cloneId: string): Promise<CloneRecord>;
}

export interface RegistryFakeOptions {
  onRegister?: (input: RegisterInput) => void | Promise<void>;
  onMarkDead?: (cloneId: string) => void | Promise<void>;
}

export function makeRegistryFake(opts: RegistryFakeOptions = {}): RegistryFake {
  const records: CloneRecord[] = [];
  let now = 1_700_000_000_000;
  return {
    records,
    async register(input) {
      if (opts.onRegister) await opts.onRegister(input);
      if (records.find(r => r.clone_id === input.clone_id)) {
        throw new Error(`clone ${input.clone_id} already registered`);
      }
      const rec: CloneRecord = {
        clone_id: input.clone_id,
        mode: input.mode,
        parent_pid: input.parent_pid,
        worktree: input.worktree,
        metadata: input.metadata,
        registered_at: now,
        last_heartbeat_at: now,
        state: 'STARTING',
      };
      now += 1;
      records.push(rec);
      return rec;
    },
    async markDead(cloneId, reason) {
      if (opts.onMarkDead) await opts.onMarkDead(cloneId);
      const rec = records.find(r => r.clone_id === cloneId);
      if (!rec) throw new Error(`not found: ${cloneId}`);
      rec.state = 'DEAD';
      rec.death_reason = reason;
      rec.died_at = now++;
      return rec;
    },
    async get(cloneId) {
      const rec = records.find(r => r.clone_id === cloneId);
      if (!rec) throw new Error(`not found: ${cloneId}`);
      return rec;
    },
  };
}
```

Run: `pnpm --filter @manta/cli typecheck`
Expected: green.

- [ ] **1.8: Failing test — spawner pre-registers clone before launching the runner**

Create `packages/manta-cli/tests/spawner/pre-register.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnClone, type CloneRunner } from '../../src/spawner/clone-spawner.js';
import { makeRegistryFake } from '../helpers/registryFake.js';
import { makeSnapshotFor } from '../helpers/snapshotFixture.js';

let repoRoot: string;
beforeEach(() => { repoRoot = mkdtempSync(join(tmpdir(), 'manta-')); });
afterEach(() => { rmSync(repoRoot, { recursive: true, force: true }); });

const fakeChild = () => ({
  pid: 12345,
  kill: () => true,
  then: (onResolve: any) => Promise.resolve({ exitCode: 0, signal: null }).then(onResolve),
} as any);

describe('spawnClone — pre-registration', () => {
  it('writes a registry record before invoking the runner', async () => {
    const events: string[] = [];
    const registry = makeRegistryFake({ onRegister: () => { events.push('register'); } });
    const runner: CloneRunner = { run: vi.fn(() => { events.push('run'); return fakeChild(); }) };

    await spawnClone({
      repoRoot,
      snapshot: makeSnapshotFor({ cloneId: 'clone-A', castId: 'cast-X' }),
      worktree: repoRoot,
      runner,
      registry,
    });

    expect(events).toEqual(['register', 'run']);
    expect(registry.records).toHaveLength(1);
    expect(registry.records[0]).toMatchObject({
      clone_id: 'clone-A',
      state: 'STARTING',
      metadata: { cast_id: 'cast-X' },
    });
  });

  it('awaits register completion before launching runner (slow-register guard)', async () => {
    const order: string[] = [];
    const slowRegister = makeRegistryFake({
      onRegister: () => new Promise((r) => setTimeout(() => { order.push('register'); r(); }, 50)),
    });
    const runner: CloneRunner = { run: vi.fn(() => { order.push('run'); return fakeChild(); }) };

    await spawnClone({
      repoRoot,
      snapshot: makeSnapshotFor({ cloneId: 'clone-B' }),
      worktree: repoRoot,
      runner,
      registry: slowRegister,
    });

    expect(order).toEqual(['register', 'run']);
  });

  it('does not invoke the runner if registry.register throws', async () => {
    const runner: CloneRunner = { run: vi.fn(() => fakeChild()) };
    const registry = makeRegistryFake({ onRegister: () => { throw new Error('boom'); } });

    await expect(spawnClone({
      repoRoot,
      snapshot: makeSnapshotFor({ cloneId: 'clone-C' }),
      worktree: repoRoot,
      runner,
      registry,
    })).rejects.toThrow(/register_failed/);

    expect(runner.run).not.toHaveBeenCalled();
  });

  it('passes priming text via runner input.appendSystemPrompt', async () => {
    const runner: CloneRunner = {
      run: vi.fn((input: { appendSystemPrompt: string; prompt: string }) => {
        expect(input.appendSystemPrompt).toContain('manta-as-clone');
        expect(input.prompt).toContain('Task:');
        return fakeChild();
      }),
    };
    await spawnClone({
      repoRoot,
      snapshot: makeSnapshotFor({ cloneId: 'clone-D' }),
      worktree: repoRoot,
      runner,
      registry: makeRegistryFake(),
    });
    expect(runner.run).toHaveBeenCalledOnce();
  });
});
```

Run: `pnpm --filter @manta/cli test`
Expected: type errors (`registry` not on `SpawnCloneOptions`, `appendSystemPrompt` not on runner input). Red. Good.

- [ ] **1.9: Extend types and pre-register from `clone-spawner.ts`**

Modify `packages/manta-cli/src/spawner/clone-spawner.ts`:

- Add at the top of the file (above `SpawnCloneOptions`):
  ```ts
  import type { RegisterInput, CloneRecord } from '@manta/bus';

  /** Narrow seam exposed by the production Bus Registry. Spawner uses only what it needs. */
  export interface RegistryWriter {
    register(input: RegisterInput): Promise<CloneRecord>;
  }
  ```
- Extend `CloneRunnerInput`: replace `snapshotPath: string` with `appendSystemPrompt: string; prompt: string`. (`snapshotPath` is no longer threaded into the runner — the env var `MANTA_SNAPSHOT_PATH` carries it; one source of truth.)
- Extend `SpawnCloneOptions`: add `registry: RegistryWriter`.
- Inside `spawnClone`, after `serializeSnapshot(...)` and before `opts.runner.run(...)`:
  ```ts
  try {
    await opts.registry.register({
      clone_id: cloneId,
      mode: opts.snapshot.taskContract.mode,
      parent_pid: process.pid,
      worktree: opts.worktree,
      metadata: { cast_id: castId },
    });
  } catch (cause) {
    throw new CliError(`failed to pre-register clone ${cloneId}`, {
      kind: 'register_failed',
      cause,
    });
  }
  ```
  (NB: snapshot file is already on disk by the time pre-register runs. If pre-register fails, the snapshot file is orphaned in `.manta/snapshots/<castId>/`. Cleanup happens in `cast.ts`'s teardown via `removeWorktree` — the worktree dir contains nothing of value at this point and is removed regardless. No additional cleanup needed in the spawner.)
- Build the `priming` and `prompt` strings via `buildPrimingText(opts.snapshot)` and `buildInitialPrompt(opts.snapshot)` and pass them to the runner via `opts.runner.run({ ..., appendSystemPrompt, prompt })`.
- Modify `runClaudeCli` (around line 165-176): replace the argv builder with:
  ```ts
  // Reason: --permission-mode bypassPermissions is the only non-interactive
  // permission mode that lets a `claude --print` session use the full tool
  // surface. `auto` would block on classifier-uncertain tools waiting for a
  // human y/n. See plan-1 lockdown for context.
  return execa(
    bin,
    [
      '--print',
      ...(opts.extraArgs ?? []),
      '--append-system-prompt', input.appendSystemPrompt,
      '--permission-mode', 'bypassPermissions',
      input.prompt,
    ],
    { cwd: input.cwd, env: { ...process.env, ...input.env }, reject: false },
  );
  ```
- `runFakeCloneScript` (the test runner) ignores `appendSystemPrompt` and `prompt` — its body remains effectively unchanged, just type-compatible with the new `CloneRunnerInput`.

Run: `pnpm --filter @manta/cli test packages/manta-cli/tests/spawner/pre-register.test.ts`
Expected: green.

Run: `pnpm --filter @manta/cli test`
Expected: existing `clone-spawner.test.ts` and `integration.test.ts` are now red — they don't pass `registry`. Continue to 1.10.

- [ ] **1.10: Update existing spawner tests**

Modify `packages/manta-cli/tests/spawner/clone-spawner.test.ts`:
- Every `spawnClone({...})` call gets `registry: makeRegistryFake()` added.
- Tests that asserted `runner` argv contained `--snapshot` flip to assert `--append-system-prompt` is present and `--snapshot` is NOT.
- Add two negative-assertion tests:
  ```ts
  it('production runClaudeCli argv contains no --snapshot flag', () => {
    const argv = capturedArgv; // from the existing argv-capture pattern
    expect(argv).not.toContain('--snapshot');
  });
  it('production runClaudeCli argv contains no --strict-mcp-config (would cut off user-scope manta-bus)', () => {
    expect(capturedArgv).not.toContain('--strict-mcp-config');
  });
  ```
- Existing tests that consume `handle.snapshotPath` keep working — the field stays on `CloneHandle`.

Run: `pnpm --filter @manta/cli test packages/manta-cli/tests/spawner/clone-spawner.test.ts`
Expected: green.

- [ ] **1.11: Update integration test to thread `runtime.ctx.registry` and the new transport**

Modify `packages/manta-cli/tests/integration.test.ts`:
- The integration test already uses `createRuntime`. Pass `runtime.ctx.registry` into `spawnClone` (the spawner is invoked under `cast.ts`'s call site that the test exercises; this is wiring through the production path, not a test-level shortcut).
- Replace any expectation of `--snapshot` argv with `--append-system-prompt` + `--permission-mode bypassPermissions`.
- Add an assertion that after `cast` returns, `runtime.ctx.registry.list()` includes a record with `clone_id` matching the spawned clone, `state: 'DEAD'`, `metadata.cast_id` matching.

Run: `pnpm --filter @manta/cli test`
Expected: green; coverage ≥ 80%.

- [ ] **1.12: Failing test — behavioural fixture for spawn → register → state-transition**

Create `packages/manta-cli/tests/spawner/startup-sequence.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

import { createRuntime } from '../../src/runtime.js';
import { spawnClone, runFakeCloneScript } from '../../src/spawner/clone-spawner.js';
import { makeSnapshotFor } from '../helpers/snapshotFixture.js';

describe('spawn → register → state transition (behavioural fixture)', () => {
  let repoRoot: string;
  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'manta-'));
    execSync('git init -q && git commit -q --allow-empty -m init', { cwd: repoRoot });
  });
  afterEach(() => { rmSync(repoRoot, { recursive: true, force: true }); });

  it('spawner pre-registers clone in real Bus Registry before runner exits', async () => {
    const rt = await createRuntime({ repoRoot });
    const fakeScriptDir = join(repoRoot, '.manta');
    mkdirSync(fakeScriptDir, { recursive: true });
    const fakeScript = join(fakeScriptDir, 'fake-clone.cjs');
    writeFileSync(fakeScript, `
      const fs = require('node:fs');
      const path = process.env.MANTA_SNAPSHOT_PATH;
      if (!path) { process.exit(2); }
      // Read the snapshot to prove the env var was wired.
      JSON.parse(fs.readFileSync(path, 'utf-8'));
      // Exit 0 immediately. The fixture asserts that the spawner registered
      // the clone *before* this script ran (Registry.get must already resolve).
      process.exit(0);
    `);

    const snap = makeSnapshotFor({ cloneId: 'clone-A', castId: 'cast-X', mode: 'recon-swarm' });
    const handle = await spawnClone({
      repoRoot,
      snapshot: snap,
      worktree: repoRoot,
      runner: runFakeCloneScript({ scriptPath: fakeScript }),
      registry: rt.ctx.registry,
    });

    // Pre-registration invariant: registry sees clone-A *now*, before exit.
    const recBeforeExit = await rt.ctx.registry.get('clone-A');
    expect(recBeforeExit).toMatchObject({
      clone_id: 'clone-A',
      state: 'STARTING',
      metadata: { cast_id: 'cast-X' },
    });

    await handle.exit;

    // After exit, the record is still there (only orchestrator's runCycle marks it DEAD).
    const recAfter = await rt.ctx.registry.get('clone-A');
    expect(recAfter.state).toBe('STARTING'); // no heartbeat happened from the fake script

    await rt.dispose();
  });

  it('Registry.get throws BusNotFoundError if pre-register did not run (sanity for the assertion above)', async () => {
    const rt = await createRuntime({ repoRoot });
    await expect(rt.ctx.registry.get('phantom')).rejects.toThrow(/clone/);
    await rt.dispose();
  });
});
```

Run: `pnpm --filter @manta/cli test packages/manta-cli/tests/spawner/startup-sequence.test.ts`
Expected: green if step 1.9 is correct.

- [ ] **1.13: Wire `runtime.ctx.registry` from `cast.ts` into `spawnClone`; track `wasRegistered` for teardown**

Modify `packages/manta-cli/src/commands/cast.ts`:

For each clone the cast is about to spawn:
1. Build `appendSystemPrompt` via `buildPrimingText(snapshot)` (import from `../spawner/priming.js`).
2. Build `prompt` via `buildInitialPrompt(snapshot)`.
3. Call `spawnClone({ ..., registry: rt.ctx.registry })`. On resolution, set `clones[i].wasRegistered = true`. On rejection (e.g. `register_failed`), set `clones[i].wasRegistered = false` and proceed to teardown of the other clones.
4. Confirm the existing pre-spawn order remains: `addWorktree → buildCloneSnapshot → contracts.write → spawnClone (= writes snapshot file → registry.register → runner.run)`. This places the contract on disk **before** the registry record exists, which is the right order: the orchestrator's first cycle reads the contract by `clone_id` after seeing the registry record. (Reverse order would race — the registry could surface a clone the orchestrator can't read a contract for yet.)

For teardown (cast failure / abort path):
- Today, `cast.ts` does NOT call `markDead` in its failure path — `terminate` and `removeWorktree` are the only side-effects. No change there.
- We do not introduce a new `markDead` call in this plan (the orchestrator owns DEAD transitions through `runPostMortem`). The `wasRegistered` flag is recorded purely for diagnostic clarity (the operator can see in error logs how far each clone got) and to guard any FUTURE markDead introduction from 404'ing on never-registered clones. Document this as a one-line comment in `cast.ts` near the flag's declaration.

Run: `pnpm --filter @manta/cli test`
Expected: green; coverage maintained.

- [ ] **1.14: Update `skills/manta-as-clone/SKILL.md`**

Read the current file. After the existing `## Allowed` section and **before** the existing `## Forbidden` section, insert:

```markdown
## Startup sequence

The very first four actions, in order, before any tool that touches files:

1. `Skill` tool → `manta-as-clone` (you are reading it now; the priming preamble told you to load it).
2. `Read` `process.env.MANTA_SNAPSHOT_PATH` to get your full task contract (JSON file).
3. `manta.heartbeat` with `{ clone_id, state: "WORKING" }`. If this returns `not_found` — your spawner did not pre-register; abort with a one-line error to the post-mortem path. Do **not** try to self-register (Phase 0 design forbids it; the spawner owns registration).
4. `manta.task_contract.read` with your `clone_id` + `manta.ack_contract` with a one-sentence interpretation.

If any of steps 2–4 fail twice, exit with a `manta-graceful-death` invocation and let the orchestrator finalize.
```

The existing line (line 17 in the current file) "The CLI spawner registered you on the bus before launching this process — you do **not** call `manta.register` yourself." stays — it is now accurate (closes bug #2's misleading-text concern).

Run validator:
```bash
node packages/manta-skill-validator/dist/bin/manta-validate-skills.cjs --root .
```
Expected: 0 errors, 0 warnings.

- [ ] **1.15: Update `commands/cast.md` — slash-command documentation**

Open `commands/cast.md`. Line 36 currently reads:
```
4. Spawns the clone process (production: `claude --print --snapshot <path>`; tests: a fake-clone fixture).
```
Replace **only the backtick-quoted command** with the real invocation, preserving the surrounding "4. Spawns the clone process (production: …; tests: a fake-clone fixture)." framing:
```
4. Spawns the clone process (production: `claude --print --append-system-prompt <priming-text> --permission-mode bypassPermissions <initial-prompt>`; tests: a fake-clone fixture).
```
This is user-readable slash-command documentation; it must match what the spawner actually invokes. Validator check stays clean (slash-command files are validated for frontmatter, not for shell-command body content).

Run validator again to confirm.

- [ ] **1.16: Update `docs/user/recon-swarm.md`**

Find the bullet "the spawner registered the clone *before* the process started" (line ~20). Replace with:

```markdown
- The spawner pre-registers the clone in the Bus *before* launching the `claude` process. This is verified by the behavioural fixture in `packages/manta-cli/tests/spawner/startup-sequence.test.ts`. (Bug #2 fix, Phase 1.)
```

- [ ] **1.17: Update `docs/user/getting-started.md` — troubleshooting callout**

Add (under the existing "Troubleshooting" section, or create one if missing):

```markdown
### Troubleshooting: clone process started but never heartbeats

Manta passes the snapshot path to each clone via the `MANTA_SNAPSHOT_PATH` env var
(plus `MANTA_REPO_ROOT` and `MANTA_CLONE_ID`). The clone is also primed via
`claude --print --append-system-prompt <text> --permission-mode bypassPermissions <prompt>`
with a fixed Manta preamble that loads the `manta-as-clone` skill and instructs
it to heartbeat first.

If `manta status` shows clones spawned but never moving past `STARTING`:

1. Run `claude --version` and verify it is ≥ 2.1.132.
2. Run `claude mcp list` and verify `manta-bus` is listed as user-scope.
3. Inspect `.manta/state/registry.json`; if a clone record is missing, the spawner failed to pre-register (file an issue with the cast-id from `.manta/casts/`).
4. If you re-run a cast after a previous failure, run `manta recover` first to clean orphaned registry records (`Registry.register` throws on duplicate `clone_id`).
```

- [ ] **1.18: Add the positive-timeline assertion to the e2e test**

Modify `packages/manta-e2e/tests/recon-swarm.e2e.test.ts`. Add a polling assertion *after* spawn and *before* the existing terminal-state assertions:

```ts
import type { CloneRecord } from '@manta/bus'; // add to existing imports

const expectedCloneCount = 2; // matches `--clones 2` argument the test passes
const tickBudgetMs = 1_500_000; // matches `--tick-budget-ms 1500000` the test passes (recon-swarm.e2e.test.ts:43)
const heartbeatBudgetMs = tickBudgetMs / 4; // 6m15s for a 25-min cast
const deadline = Date.now() + heartbeatBudgetMs;

let allMovedFromStarting = false;
let lastSnapshot: CloneRecord[] = [];
while (Date.now() < deadline) {
  lastSnapshot = await rt.ctx.registry.list();
  // last_heartbeat_at is non-zero from register, so it cannot prove liveness.
  // The state transition STARTING → WORKING (or any other terminal/non-starting state)
  // IS the unambiguous "clone heartbeated" signal.
  if (
    lastSnapshot.length === expectedCloneCount &&
    lastSnapshot.every((r) => r.state !== 'STARTING')
  ) {
    allMovedFromStarting = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 2_000));
}
if (!allMovedFromStarting) {
  throw new Error(
    `e2e: not all clones transitioned away from STARTING within ${heartbeatBudgetMs}ms; ` +
    `registry=${JSON.stringify(lastSnapshot)}`,
  );
}
```

Bug #3 was a 30-min vitest hang. With this assertion, a wedged clone fails fast (≤ 5 min for default 20-min cast) with an explicit registry dump.

- [ ] **1.19: Local pre-flight before dogfood**

Run, in order:
```bash
pnpm -r --workspace-concurrency=1 build
pnpm -r --workspace-concurrency=1 lint
pnpm -r --workspace-concurrency=1 typecheck
pnpm -r --workspace-concurrency=1 test
node packages/manta-skill-validator/dist/bin/manta-validate-skills.cjs --root .
```
Expected: every command exits 0. If any fails: STOP, fix, re-run.

- [ ] **1.20: Manta state cleanup before dogfood**

Bug-context: previous failed e2e attempts left orphan records in `.manta/state/registry.json`. `Registry.register` throws on duplicate `clone_id`. Before dogfood:

```bash
rm -rf .manta/state .manta/snapshots .manta/casts .manta/clones
```
(All four dirs are gitignored; this is a local-state reset, not a destructive repo action.) Document the cleanup step in the post-mortem.

For long-term: `manta recover` already handles this case (removing DEAD records and orphan locks). User docs (step 1.17) point at it. Phase 1 does not change `manta recover`'s behaviour.

- [ ] **1.21: Manual dogfood — `MANTA_E2E=1 pnpm e2e:recon-swarm`**

Pre-flight per `docs/user/getting-started.md`:
```bash
claude mcp list | grep manta-bus
```
If absent:
```bash
claude mcp add -s user manta-bus -- node "$(pwd)/packages/manta-bus/dist/bin/server.cjs"
```

Run:
```bash
MANTA_E2E=1 pnpm e2e:recon-swarm 2>&1 | tee .manta/dogfood-2026-05-07.log
```

Expected timeline:
1. Pre-flight passes (3/3 tests).
2. e2e cast: 2 clones spawn (`ps` shows two `claude --print --append-system-prompt … --permission-mode bypassPermissions …` processes).
3. Within `tick_budget_ms / 4` (≤ 6m15s for the e2e default of `--tick-budget-ms 1500000` = 25 min) both clones transition `state: STARTING → WORKING` — the new positive-timeline assertion fires green.
4. Clones do their work, write outputs inside `allowedPaths`, call `manta.suicide_intent`, `manta.report_death`, exit 0.
5. Orchestrator marks DEAD, writes post-mortems to `.manta/casts/<cast-id>/post-mortems/`.
6. Test asserts terminal state (DEAD records + post-mortems on disk) — green.

Capture for the post-mortem:
- The cast-id from `.manta/casts/`.
- Total wall time in `mm:ss` format.
- Approximate cost in `$X.XX` (extract via `grep -i 'cost\|usd' .manta/dogfood-2026-05-07.log`; if absent, note that and note the per-clone budget cap of $5 × 2 clones = ≤ $10 total).
- `claude --version`.
- Any surprises (clone took 2x longer, broadcast events received, lock contention, skill drift).

If the e2e fails: do **not** mark this task complete. Diagnose, fix, re-run. If a fix touches code beyond Chunk 1's stated scope, log it as a separate sub-issue in `docs/manta-bugs.md`.

- [ ] **1.22: Write `docs/post-mortems/2026-05-07-phase-1-lockdown-cast.md`**

Template (fill from the dogfood log):

```markdown
# Phase 1 lockdown — dogfood cast post-mortem

**Date:** 2026-05-07
**Cast ID:** <id from .manta/casts/>
**Mode:** recon-swarm
**Clones:** 2 × claude-haiku-4-5 (or whatever the e2e test specifies)
**Wall time:** mm:ss
**Cost:** $X.XX (per-clone cap: $5; per-cast cap: $10 actual, $15 max)
**`claude --version`:** <observed>

## Outcome

<one paragraph: did clones converge on a coherent map; were post-mortems written; any wedge>

## Timeline (signal not narrative)

- t=0:00: cast launched
- t=0:XX: clone-A first heartbeat (state: STARTING → WORKING)
- t=0:XX: clone-B first heartbeat
- t=X:XX: first `manta.broadcast` (event_type=…)
- t=X:XX: first `suicide_intent`
- t=X:XX: registry shows DEAD for both
- t=X:XX: orchestrator wrote post-mortems

## Bugs found / re-confirmed

<bullets with severity + reproducer; include positive negatives like "no flaky locks observed">

## Skill / orchestrator drift

<did the clones do exactly what manta-as-clone instructed; if not, what diverged>

## Insights for the spec

<anything that should be reflected in the spec or in PROJECT.md>

## Lessons / next-cast adjustments

<one or two bullets — small, actionable>
```

Save and stage for the chunk's commit.

- [ ] **1.23: Update `docs/manta-bugs.md` — flip #2/#3/#4**

For each:
- Change `**Status:** Open` → `**Status:** Fixed in <commit-pending>` (placeholder; filled by the follow-up commit per CLAUDE.md no-amend rule).
- Append a `**Fix:** ` line linking to the post-mortem (`docs/post-mortems/2026-05-07-phase-1-lockdown-cast.md`) and the relevant test files (`packages/manta-cli/tests/spawner/startup-sequence.test.ts`, `pre-register.test.ts`, `priming.test.ts`).

Move all three entries from "## Open bugs" to "## Fixed bugs" (line 89 currently `_Пусто._`).

- [ ] **1.24: Update `docs/acceptance/phase-0.md` — re-tick each BLOCKED row**

Read the e2e block (lines ~36-48). Each row currently formatted as `- [ ] **HUNG** — …` flips to `- [x] — <ticked rationale>`. Enumerate every checkbox in the e2e block:
- e2e cast launches successfully → tick.
- Both clones register on the Bus → tick.
- Both clones produce post-mortems → tick.
- Cast wall-time within budget → tick.
- All artifacts on disk → tick.

Add at the top of the e2e block: `Cast-id evidence: <cast-id>; see docs/post-mortems/2026-05-07-phase-1-lockdown-cast.md`.

Leave the human sign-off line at the bottom unchecked (the user signs).

- [ ] **1.25: Update `docs/superpowers/plans/INDEX.md`**

Add a new heading after the Phase-0 table:

```markdown
## Phase 1 — `recon-swarm` Production-Grade Lockdown

Цель: закрыть bugs #2/#3/#4 чтобы Phase-0 GA gate подписать. Solo (последняя solo-фаза перед bootstrap-by-Manta).

| План | Статус | Содержит |
|---|---|---|
| `2026-05-07-phase-1-recon-swarm-lockdown.md` | **Approved — ready to execute** (after plan-review checkpoint) → flip to **Executed** after Chunk 1 commit | Chunk 1: spawner pre-registration via `runtime.ctx.registry`, replace `--snapshot` with `--append-system-prompt` + `--permission-mode bypassPermissions`, behavioural-fixture test (state STARTING → non-STARTING signal), e2e positive timeline assertion, dogfood + bug-log + acceptance updates, post-mortem |
```

After Chunk 1 commits, change status to `Executed — Chunk 1 (<commit-pending>); see post-mortem`.

- [ ] **1.26: Final pre-commit gate**

Run, in order:
```bash
pnpm -r --workspace-concurrency=1 build
pnpm -r --workspace-concurrency=1 lint
pnpm -r --workspace-concurrency=1 typecheck
pnpm -r --workspace-concurrency=1 test
node packages/manta-skill-validator/dist/bin/manta-validate-skills.cjs --root .
```
All green.

Sanity grep:
```bash
rg -n 'TODO|FIXME|XXX|it\.skip|test\.skip|describe\.skip|xit\(|xdescribe\(|@ts-ignore|@ts-nocheck' \
  packages/manta-cli/src packages/manta-cli/tests packages/manta-e2e \
  | grep -v -E '(\.snap|\.md):'
```
Expected: empty.

```bash
rg --hidden -n -- '--snapshot' packages/manta-cli skills commands docs/user
```
Expected: zero hits in `packages/manta-cli/`, zero hits in `skills/`, zero hits in `commands/`, zero hits in `docs/user/`. (Hits in `docs/manta-bugs.md` documenting the historical bug are OK and expected.)

- [ ] **1.27: Atomic commit — Chunk 1**

```bash
git -c user.email="tr00x@proton.me" -c user.name="Tim Hunt" add \
  packages/manta-cli/src/errors.ts \
  packages/manta-cli/src/spawner/clone-spawner.ts \
  packages/manta-cli/src/spawner/priming.ts \
  packages/manta-cli/src/runtime.ts \
  packages/manta-cli/src/commands/cast.ts \
  packages/manta-cli/tests/helpers/registryFake.ts \
  packages/manta-cli/tests/helpers/snapshotFixture.ts \
  packages/manta-cli/tests/spawner/clone-spawner.test.ts \
  packages/manta-cli/tests/spawner/priming.test.ts \
  packages/manta-cli/tests/spawner/pre-register.test.ts \
  packages/manta-cli/tests/spawner/startup-sequence.test.ts \
  packages/manta-cli/tests/integration.test.ts \
  packages/manta-e2e/tests/recon-swarm.e2e.test.ts \
  skills/manta-as-clone/SKILL.md \
  commands/cast.md \
  docs/user/recon-swarm.md \
  docs/user/getting-started.md \
  docs/manta-bugs.md \
  docs/acceptance/phase-0.md \
  docs/post-mortems/2026-05-07-phase-1-lockdown-cast.md \
  docs/superpowers/plans/2026-05-07-phase-1-recon-swarm-lockdown.md \
  docs/superpowers/plans/INDEX.md

git -c user.email="tr00x@proton.me" -c user.name="Tim Hunt" commit -m "$(cat <<'EOF'
fix(phase-1): lockdown — pre-register clones, real --append-system-prompt transport

Closes manta-bugs #2/#3/#4. Phase-0 e2e cast hung against the real `claude`
binary because the spawner passed an unknown `--snapshot` flag (silently
ignored by the CLI) and never wrote a Registry record for the spawned clone.

Changes:
- @manta/cli spawner pre-registers the clone via runtime.ctx.registry.register
  ({ clone_id, mode, parent_pid, worktree, metadata: { cast_id } }) before
  launching the runner. The skill text in manta-as-clone is now accurate
  ("the CLI spawner registered you …"). RegistryWriter narrow seam exposed
  for unit-test fakes.
- runClaudeCli replaces `--snapshot <path>` with `--append-system-prompt <text>`
  + `--permission-mode bypassPermissions` + initial prompt as the trailing
  positional arg. The priming text loads the manta-as-clone skill, points at
  MANTA_SNAPSHOT_PATH (which the spawner already exports), and demands
  manta.heartbeat as the first action.
- New behavioural fixture (tests/spawner/startup-sequence.test.ts) exercises
  spawn → register → state-transition as a positive sequence — the gap
  Phase 0 e2e missed. Liveness signal is `state !== 'STARTING'`, NOT
  `last_heartbeat_at` (which is non-zero from register).
- Phase-0f e2e gains a positive-timeline assertion: each clone transitions
  away from STARTING within cast_timeout / 4 of spawn, otherwise fail with
  registry dump (vs the previous 30-min vitest hang).
- Skill manta-as-clone gains an explicit `## Startup sequence` block; user
  docs (recon-swarm.md, getting-started.md) and slash-command docs
  (commands/cast.md) point at the env-var-based snapshot transport. New
  `register_failed` CliError kind.
- docs/manta-bugs.md: bugs #2/#3/#4 moved to Fixed (commit-sha placeholder
  `<commit-pending>` filled by follow-up commit; CLAUDE.md no-amend rule).
- docs/acceptance/phase-0.md: each BLOCKED row reticked, cast-id linked,
  human sign-off still pending.
- docs/post-mortems/2026-05-07-phase-1-lockdown-cast.md: dogfood evidence.
- docs/superpowers/plans/INDEX.md: Phase-1 row added.

Coverage: @manta/cli ≥ 80% statement; whole-workspace 313+ unit tests green;
e2e green against real `claude` binary (see post-mortem for cast-id and timing).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Verify:
```bash
git log -1 --stat
git status
```

- [ ] **1.28: Follow-up commit — fill `<commit-pending>` placeholders**

Find the commit SHA from `git log -1 --format=%H`. In `docs/manta-bugs.md` (and any other file using `<commit-pending>` from step 1.23), replace the placeholder with the actual SHA.

```bash
SHA=$(git log -1 --format=%H)
# Use Edit tool / sed -i / your editor to replace <commit-pending> with $SHA in:
# - docs/manta-bugs.md (3 occurrences)
# - docs/superpowers/plans/INDEX.md (1 occurrence)
# Verify zero remaining hits:
rg -n 'commit-pending' docs/

git -c user.email="tr00x@proton.me" -c user.name="Tim Hunt" add docs/manta-bugs.md docs/superpowers/plans/INDEX.md
git -c user.email="tr00x@proton.me" -c user.name="Tim Hunt" commit -m "$(cat <<EOF
docs(phase-1): fill commit-sha references for lockdown commit

Backfills the <commit-pending> placeholders in docs/manta-bugs.md and
docs/superpowers/plans/INDEX.md with $SHA (the Phase-1 lockdown commit).
Per CLAUDE.md, we do NOT amend the original commit; this is a separate
no-code-change docs commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Verify:
```bash
rg -n 'commit-pending' docs/
git log --oneline -2
```
Expected: zero `commit-pending` hits; two new commits visible.

---

## Plan review checkpoint

**Before** Chunk 1 execution starts:
1. Dispatch plan-document-reviewer with this plan + the design spec + `docs/manta-bugs.md` + the actual source of `clone-spawner.ts`, `runtime.ts`, `cast.ts`, and `packages/manta-bus/src/state/registry.ts`. Reviewer checks (verbatim from the previous review iteration that produced this revision):
   - Real `claude` CLI flags (`--append-system-prompt`, `--permission-mode bypassPermissions`).
   - `Registry.register` signature drift — must match `RegisterInput = { clone_id, mode, parent_pid, worktree, metadata }`.
   - `runtime.ctx.registry` (NOT `runtime.bus.registry`).
   - `CloneState` enum is uppercase (`'STARTING'` not `'starting'`).
   - `CloneRecord` fields are snake_case.
   - Liveness signal is `state !== 'STARTING'`, not `last_heartbeat_at`.
   - Test paths under `tests/spawner/` subdir.
   - Permission mode is `bypassPermissions`, not `auto`.
   - No `--strict-mcp-config` regression.
   - Behavioural fixture genuinely proves pre-registration.
   - Snapshot test fixtures use `buildCloneSnapshot` via `makeSnapshotFor` helper.
   - `createRuntime` is the real entry point (no `createBus`).
   - `Registry.get` throws `BusNotFoundError`, does not return null.
   - No leftover `--snapshot` references outside `docs/manta-bugs.md`.
   - Atomic-commit `git add` paths exist.
   - CLAUDE.md compliance (no TODO/skip/`@ts-ignore`).
2. Apply any blocking feedback before flipping INDEX.md to `Approved — ready to execute`.

**After** Chunk 1 commits:
1. Optional sanity re-review.
2. INDEX.md status flip to `Executed`.

---

## Phase 1 closeout

This plan is the bridge between Phase-0 (foundation) and Phase-2 (forking-realities). When this chunk is `Executed`:

- `docs/acceptance/phase-0.md` is human-signable. The user signs it.
- The `manta-bugs.md` Open list shrinks to bug #1 only (the integration-test concurrency flake — Low severity, deferred).
- The next milestone opens: **Phase 2 — `forking-realities`**. Per CLAUDE.md, Phase 2's plan file is the *first* artifact written **with the help of working clones** (recon-swarm cast against this codebase to map the change surface) — bootstrap-by-Manta begins for real.
- Curator-mode discipline (CLAUDE.md "Operating mode (Phase 1+) — Main = curator") becomes load-bearing: from now on, default instinct on a non-trivial task is `manta-cast-decide` first, do-it-myself second.
