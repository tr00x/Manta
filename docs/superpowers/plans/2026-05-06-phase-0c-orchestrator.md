# Phase 0c — `@manta/orchestrator` Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build production-ready `@manta/orchestrator` — the lifecycle policy layer that drives a Manta cast forward by detecting dead/zombie clones (heartbeat staleness + parent-PID liveness), reaping stale locks and expired claims, writing structured post-mortems, and emitting observability events. Phase 0 ships a library that the CLI (Phase 0d) calls on a tick; daemon-mode runtime is deferred to Phase 5.

**Architecture:** Pure TS library exposing one class — `Orchestrator` — that composes the stores already built in `@manta/bus`. The class takes a `BusContext` plus a small `Thresholds` record and exposes `runCycle()`, `findDeadClones()`, `reapLocks()`, `reapClaims()`, `runPostMortem(cloneId, reason)`, `getStatus()`. Each phase of a cycle is a free function in its own file so it can be unit-tested in isolation against in-memory store fakes. Parent-PID liveness uses `process.kill(pid, 0)` (POSIX-portable; throws `ESRCH` if the process is gone). The post-mortem writer is a pluggable interface so tests don't touch the real filesystem.

**Tech Stack:** TypeScript 5.x strict, Node 20+, vitest, tsup. Workspace dependency on `@manta/bus`. No new runtime deps.

**Non-goals for Phase 0c:**
- Daemon-mode runtime (Phase 5) — Phase 0 invokes `runCycle` from the CLI tick
- Charge / cooldown / budget bookkeeping (Phase 3 — orchestrator only emits state-change events; the charge ledger is a separate concern)
- Best-of-N merge review (Phase 2, `forking-realities` only)
- Worktree creation / teardown (Phase 0d, `manta-cli`)
- Auto-cast triggers (Phase 7)
- Notification routing / batching / whisper mode (Phase 11.0+ tiers)

**Quality bar (CLAUDE.md / spec Sec 14):**
- Test coverage ≥ 80 % on lines/functions/branches/statements for `src/**/*.ts` (excluding `src/index.ts`)
- TDD per task: failing test → run → minimal impl → re-run → commit
- No `// TODO: implement` in merged code
- Atomic, conventional commits
- Ships with `README.md` + `ARCHITECTURE.md`

**Reference docs:**
- Source-of-truth design: `docs/superpowers/specs/2026-05-06-manta-pattern-design.md` — Sec 3 (Lifecycle), Sec 6 (Game mechanics — TTL, fragility), Sec 7 (Post-Mortem Flow), Sec 9 (Tech Stack — blocker #5 zombie processes)
- Predecessor plans: `2026-05-06-phase-0-foundation.md`, `2026-05-06-phase-0b-bus.md`
- Project rules: `CLAUDE.md`

---

## Chunks

1. **Chunk 1 — Detection, reapers, post-mortem** — package skeleton, `Thresholds`, `parent-pid`, `death-detector`, `lock-reaper`, `claim-reaper`, `post-mortem-writer`, `post-mortem`. Pure functions/classes, each unit-tested against in-memory store fakes. After this chunk: `pnpm --filter @manta/orchestrator test:coverage` green even though the orchestrator class doesn't exist yet.
2. **Chunk 2 — `Orchestrator` class + cycle integration** — `errors`, `status`, `Orchestrator` (composes Chunk 1 pieces), an end-to-end integration test that wires a real `BusContext` from `@manta/bus`, runs a full cycle, and asserts state transitions. README + ARCHITECTURE.

---

## Chunk 1: Detection, reapers, post-mortem

**Goal of this chunk:** Build five focused units that each turn a fact in the bus into an action: "is this clone dead?", "is the parent alive?", "are these locks stale?", "are these claims expired?", "what does the post-mortem look like?". Each is an isolated function with no transitive dependencies, so the failure mode of any one is small and testable.

**Files (new):**
- Create: `packages/manta-orchestrator/package.json`
- Create: `packages/manta-orchestrator/tsconfig.json`
- Create: `packages/manta-orchestrator/tsup.config.ts`
- Create: `packages/manta-orchestrator/vitest.config.ts`
- Create: `packages/manta-orchestrator/src/index.ts` — re-exports only
- Create: `packages/manta-orchestrator/src/thresholds.ts`
- Create: `packages/manta-orchestrator/src/parent-pid.ts`
- Create: `packages/manta-orchestrator/src/death-detector.ts`
- Create: `packages/manta-orchestrator/src/lock-reaper.ts`
- Create: `packages/manta-orchestrator/src/claim-reaper.ts`
- Create: `packages/manta-orchestrator/src/post-mortem-writer.ts`
- Create: `packages/manta-orchestrator/src/post-mortem.ts`
- Create: `packages/manta-orchestrator/tests/thresholds.test.ts`
- Create: `packages/manta-orchestrator/tests/parent-pid.test.ts`
- Create: `packages/manta-orchestrator/tests/death-detector.test.ts`
- Create: `packages/manta-orchestrator/tests/lock-reaper.test.ts`
- Create: `packages/manta-orchestrator/tests/claim-reaper.test.ts`
- Create: `packages/manta-orchestrator/tests/post-mortem-writer.test.ts`
- Create: `packages/manta-orchestrator/tests/post-mortem.test.ts`
- Create: `packages/manta-orchestrator/tests/helpers/buildBusContext.ts`
- Modify: root `tsconfig.json` — add `{ "path": "./packages/manta-orchestrator" }` to `references`

**Why these boundaries:**
- One concern per file. `parent-pid` is the only piece that touches `process`; isolating it lets tests stub it via dependency injection without monkeypatching `process`.
- Reapers split from detector because they consume different stores (locks vs claims) and emit different event types.
- `post-mortem-writer` is the IO seam: production writes to `docs/post-mortems/`, tests pass a writer that captures in memory. `post-mortem.ts` is the composer (gathers events, formats markdown, calls the writer); kept separate so the formatting logic is testable without disk.
- `thresholds.ts` exists so consumers can override values per environment without editing a constants module.
- `tests/helpers/buildBusContext.ts` returns a real `BusContext` over a tmpdir so tests don't reinvent the wiring.

### Tasks

- [ ] **1.1: Verify Phase 0b shipped**

Run: `pnpm --filter @manta/bus build && pnpm --filter @manta/bus test`
Expected: both succeed.
If either fails: STOP — orchestrator depends on a green bus.

- [ ] **1.2: Verify there is no existing `packages/manta-orchestrator/` directory**

Run: `ls packages/manta-orchestrator 2>&1 | head -5`
Expected: `ls: ... No such file or directory`. If the directory exists: STOP and inspect.

- [ ] **1.3: Create `packages/manta-orchestrator/package.json`**

```json
{
  "name": "@manta/orchestrator",
  "version": "0.0.0",
  "private": true,
  "description": "Manta Orchestrator — lifecycle policy: dead-clone detection, stale-lock reaping, post-mortem authoring",
  "license": "MIT",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "require": "./dist/index.cjs",
      "types": "./dist/index.d.ts"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "lint": "eslint \"src/**/*.ts\" \"tests/**/*.ts\"",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@manta/bus": "workspace:*",
    "@manta/snapshot": "workspace:*",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^20.12.0",
    "@vitest/coverage-v8": "^1.6.0",
    "tsup": "^8.0.0",
    "typescript": "^5.4.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **1.4: Create `tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": ".",
    "outDir": "dist",
    "composite": true,
    "tsBuildInfoFile": "dist/.tsbuildinfo"
  },
  "include": ["src/**/*", "tests/**/*"],
  "references": [
    { "path": "../manta-bus" },
    { "path": "../manta-snapshot" }
  ]
}
```

- [ ] **1.5: Create `tsup.config.ts`**

```typescript
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  dts: { entry: 'src/index.ts' },
  clean: true,
  sourcemap: true,
  target: 'node20',
  splitting: false,
  shims: true,
});
```

- [ ] **1.6: Create `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globals: false,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
```

- [ ] **1.7: Add `@manta/orchestrator` to root `tsconfig.json` references**

`Edit` the root `tsconfig.json` to append `{ "path": "./packages/manta-orchestrator" }` to its `references` array. Preserve existing references.

Verify: `cat tsconfig.json | grep manta-orchestrator` — must show the new entry.

- [ ] **1.8: Install workspace deps**

Run: `pnpm install`
Expected: lockfile updates; no resolution errors.

- [ ] **1.9: Sanity-check resolution**

Run: `node -e "require.resolve('@manta/bus')"` from `packages/manta-orchestrator` directory.
Expected: prints the resolved path with no error. If it fails: workspace linking is broken — re-run `pnpm install` from repo root.

- [ ] **1.10: Write failing tests for `thresholds.ts`**

Create `packages/manta-orchestrator/tests/thresholds.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { defaultThresholds, mergeThresholds, ThresholdsSchema } from '../src/thresholds';

describe('thresholds', () => {
  it('defaults match Sec 6.2 / Sec 6.3 / Sec 9 blocker #5', () => {
    expect(defaultThresholds.heartbeatTimeoutMs).toBe(30_000);
    expect(defaultThresholds.staleLockMs).toBe(15_000);
    expect(defaultThresholds.parentPidCheckEnabled).toBe(true);
    expect(defaultThresholds.cycleIntervalMs).toBe(5_000);
    expect(defaultThresholds.postMortemDir).toBe('docs/post-mortems');
  });

  it('mergeThresholds overlays partial overrides', () => {
    const merged = mergeThresholds({ heartbeatTimeoutMs: 60_000 });
    expect(merged.heartbeatTimeoutMs).toBe(60_000);
    expect(merged.staleLockMs).toBe(defaultThresholds.staleLockMs);
  });

  it('ThresholdsSchema rejects negative timeouts', () => {
    expect(() => ThresholdsSchema.parse({ ...defaultThresholds, heartbeatTimeoutMs: -1 })).toThrow();
    expect(() => ThresholdsSchema.parse({ ...defaultThresholds, staleLockMs: 0 })).toThrow();
  });
});
```

- [ ] **1.11: Run failing thresholds test**

Run: `pnpm --filter @manta/orchestrator test thresholds.test.ts`
Expected: FAIL — module missing.

- [ ] **1.12: Implement `thresholds.ts`**

Create `packages/manta-orchestrator/src/thresholds.ts`:

```typescript
import { z } from 'zod';

export const ThresholdsSchema = z
  .object({
    heartbeatTimeoutMs: z.number().int().positive(),
    staleLockMs: z.number().int().positive(),
    parentPidCheckEnabled: z.boolean(),
    cycleIntervalMs: z.number().int().positive(),
    postMortemDir: z.string().min(1),
  })
  .strict();

export type Thresholds = z.infer<typeof ThresholdsSchema>;

// Defaults sourced from spec:
//  - heartbeatTimeoutMs (30s): Sec 9 blocker #5 — "Suicide через 30 сек после смерти parent"
//    (and a clone that hasn't heartbeated in 30s is presumed dead even with parent alive)
//  - staleLockMs (15s): Sec 4 — locks renew every 5s; 15s = 3 missed renews
//  - cycleIntervalMs (5s): mid-point between 5s lock-renew cadence and 30s heartbeat;
//    catches dead clones within one heartbeat window without thrashing.
//  - parentPidCheckEnabled: spec Sec 9 blocker #5 — must be on by default
export const defaultThresholds: Thresholds = {
  heartbeatTimeoutMs: 30_000,
  staleLockMs: 15_000,
  parentPidCheckEnabled: true,
  cycleIntervalMs: 5_000,
  postMortemDir: 'docs/post-mortems',
};

export function mergeThresholds(override: Partial<Thresholds>): Thresholds {
  return ThresholdsSchema.parse({ ...defaultThresholds, ...override });
}
```

- [ ] **1.13: Re-run thresholds test**

Run: `pnpm --filter @manta/orchestrator test thresholds.test.ts`
Expected: 3/3 passing.

- [ ] **1.14: Write failing tests for `parent-pid.ts`**

Create `packages/manta-orchestrator/tests/parent-pid.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { isProcessAlive, makeProbe } from '../src/parent-pid';

describe('parent-pid', () => {
  it('isProcessAlive reports true for the current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('isProcessAlive reports false for a definitely-dead PID', () => {
    // spawn `node -e "process.exit(0)"`, capture its pid AFTER exit
    const result = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    expect(result.status).toBe(0);
    expect(typeof result.pid).toBe('number');
    // small wait to be safe — kernel may take a moment to free the slot, but kill(0)
    // returns ESRCH as soon as the process leaves the table.
    expect(isProcessAlive(result.pid!)).toBe(false);
  });

  it('isProcessAlive returns false for non-positive PIDs', () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
  });

  it('makeProbe returns an injectable probe that wraps isProcessAlive by default', () => {
    const probe = makeProbe();
    expect(probe.alive(process.pid)).toBe(true);
  });

  it('makeProbe accepts an override for testing', () => {
    const probe = makeProbe({ alive: (pid) => pid === 42 });
    expect(probe.alive(42)).toBe(true);
    expect(probe.alive(99)).toBe(false);
  });
});
```

- [ ] **1.15: Run failing parent-pid test**

Run: `pnpm --filter @manta/orchestrator test parent-pid.test.ts`
Expected: FAIL — module missing.

- [ ] **1.16: Implement `parent-pid.ts`**

Create `packages/manta-orchestrator/src/parent-pid.ts`:

```typescript
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 is the canonical "is this PID alive?" probe on POSIX.
    // On Windows this throws EPERM for live processes; we treat any throw
    // as "dead" except EPERM, which means the process exists but we can't
    // signal it (still alive from an orchestrator's perspective).
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    return false;
  }
}

export interface PidProbe {
  alive(pid: number): boolean;
}

export interface MakeProbeOptions {
  alive?: (pid: number) => boolean;
}

export function makeProbe(opts: MakeProbeOptions = {}): PidProbe {
  return {
    alive: opts.alive ?? isProcessAlive,
  };
}
```

- [ ] **1.17: Re-run parent-pid test**

Run: `pnpm --filter @manta/orchestrator test parent-pid.test.ts`
Expected: 5/5 passing.

- [ ] **1.18: Build the `buildBusContext` test helper (with bus re-export prerequisite)**

`@manta/bus`'s top-level `src/index.ts` (per phase-0b-bus.md) does not currently re-export `BusContext` from `./tools/index` — only the value-side symbols are forwarded. The orchestrator helper depends on this type, so we elevate it as a hard pre-step.

Sub-task 1.18a — extend `@manta/bus` re-exports:

`Edit` `packages/manta-bus/src/index.ts` to append (preserving prior re-exports):

```typescript
export type { BusContext, SubsetContext } from './tools/index';
export type { MemoryWriters, ZkWriteRequest, ParaAppendRequest } from './memory-writers';
```

(If a `MemoryWriters` re-export is already present from a phase-0b-bus.md follow-up, do not duplicate.)

Verify:
```
pnpm --filter @manta/bus build && grep -c "BusContext" packages/manta-bus/dist/index.d.ts
```
Expected: build succeeds; `grep` reports a count ≥ 1.
If build fails with a circular or missing-path error: STOP, inspect `tools/index.ts` — `BusContext` must be exported as `interface` (or `type`, if `export type {...} from` is used).

Sub-task 1.18b — create `packages/manta-orchestrator/tests/helpers/buildBusContext.ts`:

```typescript
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FakeClock, busPaths, Registry, LocksStore, ClaimsStore, ContractsStore, EventsLog, fsMemoryWriters } from '@manta/bus';
import type { BusContext } from '@manta/bus';

export interface TestBusContext extends BusContext {
  root: string;
  cleanup: () => Promise<void>;
  clock: FakeClock;
}

export async function buildBusContext(epoch = 1_000_000): Promise<TestBusContext> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-orchestrator-test-'));
  await fs.mkdir(path.join(root, '.manta', 'state', 'contracts'), { recursive: true });
  const clock = new FakeClock(epoch);
  const paths = busPaths(root);
  const ctx: TestBusContext = {
    root,
    clock,
    paths,
    registry: new Registry(paths, clock),
    locks: new LocksStore(paths, clock, { staleAfterMs: 15_000 }),
    claims: new ClaimsStore(paths, clock),
    contracts: new ContractsStore(paths, clock),
    events: new EventsLog(paths, clock),
    memoryWriters: fsMemoryWriters({ repoRoot: root, clock }),
    cleanup: async () => fs.rm(root, { recursive: true, force: true }),
  };
  return ctx;
}
```

Verify: `pnpm --filter @manta/orchestrator typecheck` succeeds. If it complains about `BusContext` not exported — Sub-task 1.18a was skipped or partial; redo before continuing.

- [ ] **1.19: Write failing tests for `death-detector.ts`**

Create `packages/manta-orchestrator/tests/death-detector.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { findDeadClones } from '../src/death-detector';
import { defaultThresholds } from '../src/thresholds';
import { makeProbe } from '../src/parent-pid';
import { buildBusContext, type TestBusContext } from './helpers/buildBusContext';

describe('death-detector', () => {
  let ctx: TestBusContext;

  beforeEach(async () => {
    ctx = await buildBusContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it('returns empty list when no clones registered', async () => {
    const result = await findDeadClones(ctx, {
      thresholds: defaultThresholds,
      probe: makeProbe({ alive: () => true }),
    });
    expect(result).toEqual([]);
  });

  it('marks heartbeat-stale clones as dead', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    ctx.clock.advance(31_000);
    const result = await findDeadClones(ctx, {
      thresholds: defaultThresholds,
      probe: makeProbe({ alive: () => true }),
    });
    expect(result).toHaveLength(1);
    expect(result[0].clone_id).toBe('A');
    expect(result[0].reason).toMatch(/heartbeat/);
  });

  it('marks orphaned clones (parent dead) as dead even if heartbeat is fresh', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 999_999_999, worktree: '/w', metadata: {} });
    ctx.clock.advance(1_000); // not stale by heartbeat
    const result = await findDeadClones(ctx, {
      thresholds: defaultThresholds,
      probe: makeProbe({ alive: () => false }),
    });
    expect(result).toHaveLength(1);
    expect(result[0].reason).toMatch(/parent/);
  });

  it('does not double-count: stale-and-orphaned reports a single record', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 999, worktree: '/w', metadata: {} });
    ctx.clock.advance(31_000);
    const result = await findDeadClones(ctx, {
      thresholds: defaultThresholds,
      probe: makeProbe({ alive: () => false }),
    });
    expect(result).toHaveLength(1);
    // Reason is composite when both triggers fire
    expect(result[0].reason).toMatch(/heartbeat/);
    expect(result[0].reason).toMatch(/parent/);
  });

  it('skips already-DEAD clones', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    await ctx.registry.markDead('A', 'prior');
    ctx.clock.advance(60_000);
    const result = await findDeadClones(ctx, {
      thresholds: defaultThresholds,
      probe: makeProbe({ alive: () => false }),
    });
    expect(result).toEqual([]);
  });

  it('honors parentPidCheckEnabled=false (skip parent probe entirely)', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 999, worktree: '/w', metadata: {} });
    ctx.clock.advance(1_000);
    const result = await findDeadClones(ctx, {
      thresholds: { ...defaultThresholds, parentPidCheckEnabled: false },
      probe: makeProbe({ alive: () => false }),
    });
    expect(result).toEqual([]);
  });
});
```

- [ ] **1.20: Run failing death-detector test**

Run: `pnpm --filter @manta/orchestrator test death-detector.test.ts`
Expected: FAIL — module missing.

- [ ] **1.21: Implement `death-detector.ts`**

Create `packages/manta-orchestrator/src/death-detector.ts`:

```typescript
import type { BusContext, CloneRecord } from '@manta/bus';
import type { Thresholds } from './thresholds';
import type { PidProbe } from './parent-pid';

export interface DeadCloneFinding {
  clone_id: string;
  record: CloneRecord;
  reason: string;
}

export interface FindDeadCloneOptions {
  thresholds: Thresholds;
  probe: PidProbe;
}

export async function findDeadClones(
  ctx: Pick<BusContext, 'registry' | 'clock'>,
  options: FindDeadCloneOptions,
): Promise<DeadCloneFinding[]> {
  const all = await ctx.registry.list();
  const now = ctx.clock.now();
  const out: DeadCloneFinding[] = [];
  for (const r of all) {
    if (r.state === 'DEAD') continue;
    const reasons: string[] = [];
    const sinceHeartbeat = now - r.last_heartbeat_at;
    if (sinceHeartbeat > options.thresholds.heartbeatTimeoutMs) {
      reasons.push(`heartbeat ${sinceHeartbeat}ms ago > ${options.thresholds.heartbeatTimeoutMs}ms`);
    }
    if (options.thresholds.parentPidCheckEnabled && !options.probe.alive(r.parent_pid)) {
      reasons.push(`parent pid ${r.parent_pid} not alive`);
    }
    if (reasons.length > 0) {
      out.push({ clone_id: r.clone_id, record: r, reason: reasons.join('; ') });
    }
  }
  return out;
}
```

- [ ] **1.22: Re-run death-detector test**

Run: `pnpm --filter @manta/orchestrator test death-detector.test.ts`
Expected: 6/6 passing.

- [ ] **1.23: Write failing tests for `lock-reaper.ts`**

Create `packages/manta-orchestrator/tests/lock-reaper.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { reapLocks } from '../src/lock-reaper';
import { buildBusContext, type TestBusContext } from './helpers/buildBusContext';

describe('lock-reaper', () => {
  let ctx: TestBusContext;
  beforeEach(async () => {
    ctx = await buildBusContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it('returns empty when no locks exist', async () => {
    const result = await reapLocks(ctx);
    expect(result.reaped).toEqual([]);
    expect(result.events).toEqual([]);
  });

  it('reaps stale locks and emits one lock_reap event per lease', async () => {
    await ctx.locks.acquire({ clone_id: 'A', path: 'src/foo.ts' });
    await ctx.locks.acquire({ clone_id: 'B', path: 'src/bar.ts' });
    ctx.clock.advance(15_001);
    await ctx.locks.renew({ clone_id: 'B', path: 'src/bar.ts' }); // B refreshes; A goes stale
    const result = await reapLocks(ctx);
    expect(result.reaped.map((l) => l.path)).toEqual(['src/foo.ts']);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].type).toBe('lock_reap');
    expect(result.events[0].payload).toMatchObject({ path: 'src/foo.ts', former_owner: 'A' });
  });

  it('emits no event when nothing was reaped', async () => {
    await ctx.locks.acquire({ clone_id: 'A', path: 'src/foo.ts' });
    const result = await reapLocks(ctx);
    expect(result.reaped).toEqual([]);
    expect(result.events).toEqual([]);
  });
});
```

- [ ] **1.24: Run failing lock-reaper test**

Run: `pnpm --filter @manta/orchestrator test lock-reaper.test.ts`
Expected: FAIL — module missing.

- [ ] **1.25: Implement `lock-reaper.ts`**

Create `packages/manta-orchestrator/src/lock-reaper.ts`:

```typescript
import type { BusContext, BusEvent, LockLease } from '@manta/bus';

export interface ReapLocksResult {
  reaped: LockLease[];
  events: BusEvent[];
}

export async function reapLocks(
  ctx: Pick<BusContext, 'locks' | 'events'>,
): Promise<ReapLocksResult> {
  const reaped = await ctx.locks.reapStale();
  const events: BusEvent[] = [];
  for (const lease of reaped) {
    const event = await ctx.events.append({
      type: 'lock_reap',
      clone_id: lease.owner_clone_id,
      payload: {
        path: lease.path,
        former_owner: lease.owner_clone_id,
        last_heartbeat_at: lease.last_heartbeat_at,
      },
    });
    events.push(event);
  }
  return { reaped, events };
}
```

- [ ] **1.26: Re-run lock-reaper test**

Run: `pnpm --filter @manta/orchestrator test lock-reaper.test.ts`
Expected: 3/3 passing.

- [ ] **1.27: Write failing tests for `claim-reaper.ts`**

Create `packages/manta-orchestrator/tests/claim-reaper.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { reapClaims } from '../src/claim-reaper';
import { buildBusContext, type TestBusContext } from './helpers/buildBusContext';

describe('claim-reaper', () => {
  let ctx: TestBusContext;
  beforeEach(async () => {
    ctx = await buildBusContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it('returns empty when no claims', async () => {
    const result = await reapClaims(ctx);
    expect(result.reaped).toEqual([]);
    expect(result.events).toEqual([]);
  });

  it('reaps expired claims and emits claim_reap events', async () => {
    await ctx.claims.claim({ clone_id: 'A', item: 'task-1', timeout_ms: 1_000 });
    await ctx.claims.claim({ clone_id: 'B', item: 'task-2', timeout_ms: 60_000 });
    ctx.clock.advance(1_001);
    const result = await reapClaims(ctx);
    expect(result.reaped.map((c) => c.item)).toEqual(['task-1']);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].type).toBe('claim_reap');
    expect(result.events[0].payload).toMatchObject({ item: 'task-1', former_owner: 'A' });
  });

  it('does not reap non-expired claims', async () => {
    await ctx.claims.claim({ clone_id: 'A', item: 'task-1', timeout_ms: 60_000 });
    ctx.clock.advance(30_000);
    const result = await reapClaims(ctx);
    expect(result.reaped).toEqual([]);
  });
});
```

- [ ] **1.28: Run failing claim-reaper test**

Run: `pnpm --filter @manta/orchestrator test claim-reaper.test.ts`
Expected: FAIL — module missing.

- [ ] **1.29: Implement `claim-reaper.ts`**

Note: `ClaimsStore` (in @manta/bus) does not currently expose a `reapStale` method analogous to `LocksStore.reapStale` — claims expire passively (next claim attempt re-takes the slot). For the orchestrator to surface expired claims as observable events, we need a non-mutating list + per-item release. The cleanest way is to add a `ClaimsStore.reapExpired()` to `@manta/bus` that mirrors `LocksStore.reapStale()`. Since this plan is for `@manta/orchestrator`, the impact on `@manta/bus` is a small additive change.

Sub-task 1.29a — extend `@manta/bus`:

`Edit` `packages/manta-bus/src/state/claims.ts` to add the method:

```typescript
  async reapExpired(): Promise<WorkClaim[]> {
    const now = this.clock.now();
    const reaped: WorkClaim[] = [];
    await atomicMutateJson<ClaimsFile>(this.paths.claims, empty, (current) => {
      for (const [item, claim] of Object.entries(current.claims)) {
        if (now >= claim.expires_at) {
          reaped.push(claim);
          delete current.claims[item];
        }
      }
      return current;
    });
    return reaped;
  }
```

`Edit` `packages/manta-bus/tests/state/claims.test.ts` to add a test:

```typescript
  it('reapExpired removes expired claims and returns them', async () => {
    await claims.claim({ clone_id: 'A', item: 'task-1', timeout_ms: 1_000 });
    await claims.claim({ clone_id: 'B', item: 'task-2', timeout_ms: 60_000 });
    clock.advance(1_001);
    const reaped = await claims.reapExpired();
    expect(reaped.map((c) => c.item)).toEqual(['task-1']);
    const remaining = await claims.list();
    expect(remaining.map((c) => c.item)).toEqual(['task-2']);
  });
```

Run: `pnpm --filter @manta/bus test state/claims.test.ts`
Expected: 9/9 passing (the existing 8 + this new one).

Sub-task 1.29b — implement the orchestrator reaper.

Create `packages/manta-orchestrator/src/claim-reaper.ts`:

```typescript
import type { BusContext, BusEvent, WorkClaim } from '@manta/bus';

export interface ReapClaimsResult {
  reaped: WorkClaim[];
  events: BusEvent[];
}

export async function reapClaims(
  ctx: Pick<BusContext, 'claims' | 'events'>,
): Promise<ReapClaimsResult> {
  const reaped = await ctx.claims.reapExpired();
  const events: BusEvent[] = [];
  for (const claim of reaped) {
    const event = await ctx.events.append({
      type: 'claim_reap',
      clone_id: claim.owner_clone_id,
      payload: {
        item: claim.item,
        former_owner: claim.owner_clone_id,
        expired_at: claim.expires_at,
      },
    });
    events.push(event);
  }
  return { reaped, events };
}
```

- [ ] **1.30: Re-run claim-reaper test + bus claims test**

Run: `pnpm --filter @manta/bus test state/claims.test.ts && pnpm --filter @manta/orchestrator test claim-reaper.test.ts`
Expected: 9/9 + 3/3 passing.

- [ ] **1.31: Write failing tests for `post-mortem-writer.ts`**

Create `packages/manta-orchestrator/tests/post-mortem-writer.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fsPostMortemWriter, inMemoryPostMortemWriter } from '../src/post-mortem-writer';

describe('post-mortem-writer', () => {
  it('inMemoryPostMortemWriter captures writes', async () => {
    const w = inMemoryPostMortemWriter();
    await w.write({ filename: '2026-05-06-cast-1-A.md', body: '# title\n\nbody\n' });
    expect(w.captured).toHaveLength(1);
    expect(w.captured[0].filename).toBe('2026-05-06-cast-1-A.md');
    expect(w.captured[0].body).toContain('# title');
  });

  it('fsPostMortemWriter writes atomically under repoRoot/postMortemDir', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-pm-'));
    try {
      const w = fsPostMortemWriter({ repoRoot: root, postMortemDir: 'docs/post-mortems' });
      await w.write({ filename: '2026-05-06-cast-1-A.md', body: '# A\n' });
      const file = path.join(root, 'docs/post-mortems', '2026-05-06-cast-1-A.md');
      const content = await fs.readFile(file, 'utf8');
      expect(content).toBe('# A\n');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('fsPostMortemWriter creates the postMortemDir if missing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-pm-'));
    try {
      const w = fsPostMortemWriter({ repoRoot: root, postMortemDir: 'nested/deep/dir' });
      await w.write({ filename: 'note.md', body: 'x' });
      const file = path.join(root, 'nested/deep/dir', 'note.md');
      await expect(fs.access(file)).resolves.toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('fsPostMortemWriter rejects path traversal in filename', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-pm-'));
    try {
      const w = fsPostMortemWriter({ repoRoot: root, postMortemDir: 'docs/post-mortems' });
      await expect(w.write({ filename: '../escape.md', body: 'x' })).rejects.toThrow();
      await expect(w.write({ filename: 'sub/dir.md', body: 'x' })).rejects.toThrow();
      await expect(w.write({ filename: '/etc/passwd', body: 'x' })).rejects.toThrow();
      await expect(w.write({ filename: '..\\windows-escape.md', body: 'x' })).rejects.toThrow();
      await expect(w.write({ filename: '', body: 'x' })).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **1.32: Run failing post-mortem-writer test**

Run: `pnpm --filter @manta/orchestrator test post-mortem-writer.test.ts`
Expected: FAIL — module missing.

- [ ] **1.33: Implement `post-mortem-writer.ts`**

Create `packages/manta-orchestrator/src/post-mortem-writer.ts`:

```typescript
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface PostMortemDocument {
  filename: string;
  body: string;
}

export interface PostMortemWriter {
  write(doc: PostMortemDocument): Promise<{ path: string }>;
}

export interface FsPostMortemWriterOptions {
  repoRoot: string;
  postMortemDir: string;
}

const SAFE_FILENAME = /^[A-Za-z0-9._-]+$/;

export function fsPostMortemWriter(opts: FsPostMortemWriterOptions): PostMortemWriter {
  return {
    async write(doc) {
      if (!SAFE_FILENAME.test(doc.filename)) {
        throw new Error(`unsafe post-mortem filename: ${doc.filename}`);
      }
      const dir = path.join(opts.repoRoot, opts.postMortemDir);
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, doc.filename);
      const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
      await fs.writeFile(tmp, doc.body, 'utf8');
      await fs.rename(tmp, file);
      return { path: file };
    },
  };
}

export interface InMemoryPostMortemWriter extends PostMortemWriter {
  captured: PostMortemDocument[];
}

export function inMemoryPostMortemWriter(): InMemoryPostMortemWriter {
  const captured: PostMortemDocument[] = [];
  return {
    captured,
    async write(doc) {
      captured.push(doc);
      return { path: `mem://${doc.filename}` };
    },
  };
}
```

- [ ] **1.34: Re-run post-mortem-writer test**

Run: `pnpm --filter @manta/orchestrator test post-mortem-writer.test.ts`
Expected: 4/4 passing.

- [ ] **1.35: Commit Chunk-1 progress (split: bus extension first, orchestrator second)**

Two atomic commits — one per package. Bundling them violates CLAUDE.md atomic-commit discipline.

Sub-task 1.35a — commit the `@manta/bus` extension:

```bash
git -c user.email="tr00x@proton.me" -c user.name="Tim Hunt" add \
  packages/manta-bus/src/index.ts \
  packages/manta-bus/src/state/claims.ts \
  packages/manta-bus/tests/state/claims.test.ts
git -c user.email="tr00x@proton.me" -c user.name="Tim Hunt" commit -m "$(cat <<'EOF'
feat(bus): add ClaimsStore.reapExpired + elevate BusContext type re-exports

- ClaimsStore.reapExpired(): mirror of LocksStore.reapStale; removes
  claims whose expires_at <= clock.now() and returns them
- src/index.ts: re-export BusContext, SubsetContext (from tools/index),
  MemoryWriters / ZkWriteRequest / ParaAppendRequest (from memory-writers)
  so external packages (orchestrator) can compose stores against the
  documented BusContext shape

Both are additive and required by @manta/orchestrator (Phase 0c).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Sub-task 1.35b — commit the orchestrator scaffold:

```bash
git -c user.email="tr00x@proton.me" -c user.name="Tim Hunt" add \
  packages/manta-orchestrator/package.json \
  packages/manta-orchestrator/tsconfig.json \
  packages/manta-orchestrator/tsup.config.ts \
  packages/manta-orchestrator/vitest.config.ts \
  packages/manta-orchestrator/src \
  packages/manta-orchestrator/tests \
  tsconfig.json pnpm-lock.yaml
git -c user.email="tr00x@proton.me" -c user.name="Tim Hunt" commit -m "$(cat <<'EOF'
feat(orchestrator): scaffold @manta/orchestrator with detection + reapers

- Package skeleton (tsup, vitest with 80% coverage gate, eslint via root)
- Thresholds: heartbeatTimeoutMs (30s) / staleLockMs (15s) / parent-pid check
- parent-pid: process.kill(pid, 0) probe with PidProbe injection seam
- death-detector: heartbeat-stale + parent-PID composite trigger
- lock-reaper: emits lock_reap events (orchestrator owns this per Phase 0b advisory)
- claim-reaper: emits claim_reap events using ClaimsStore.reapExpired
- post-mortem-writer: pluggable writer (fs/in-memory) with atomic temp+rename

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Run: `git log --oneline -3` — verify both commits landed in order (bus first, orchestrator second).

- [ ] **1.36: Write failing tests for `post-mortem.ts`**

Create `packages/manta-orchestrator/tests/post-mortem.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runPostMortem } from '../src/post-mortem';
import { inMemoryPostMortemWriter } from '../src/post-mortem-writer';
import { defaultThresholds } from '../src/thresholds';
import { buildBusContext, type TestBusContext } from './helpers/buildBusContext';

describe('post-mortem', () => {
  let ctx: TestBusContext;
  beforeEach(async () => {
    ctx = await buildBusContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it('writes a post-mortem markdown for a registered then dead clone', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: { cast_id: 'cast-42' } });
    await ctx.registry.heartbeat({ clone_id: 'A', state: 'WORKING', progress: 'half' });
    await ctx.events.append({ type: 'broadcast', clone_id: 'A', payload: { event_type: 'breakthrough', body: { summary: 'found root cause' } } });
    ctx.clock.advance(31_000);
    const writer = inMemoryPostMortemWriter();
    const result = await runPostMortem(ctx, {
      cloneId: 'A',
      reason: 'heartbeat 31000ms ago > 30000ms',
      writer,
      thresholds: defaultThresholds,
    });
    expect(result.event.type).toBe('post_mortem');
    expect(writer.captured).toHaveLength(1);
    const md = writer.captured[0].body;
    expect(md).toContain('# Post-mortem — clone A');
    expect(md).toContain('Reason: heartbeat 31000ms ago > 30000ms');
    expect(md).toContain('cast-42');
    expect(md).toContain('breakthrough');
    expect(writer.captured[0].filename).toMatch(/^\d{4}-\d{2}-\d{2}-cast-42-A\.md$/);
  });

  it('uses "no-cast" prefix when metadata lacks cast_id', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    ctx.clock.advance(31_000);
    const writer = inMemoryPostMortemWriter();
    await runPostMortem(ctx, {
      cloneId: 'A',
      reason: 'stale',
      writer,
      thresholds: defaultThresholds,
    });
    expect(writer.captured[0].filename).toMatch(/-no-cast-A\.md$/);
  });

  it('marks the clone DEAD if it was not already', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    const writer = inMemoryPostMortemWriter();
    await runPostMortem(ctx, { cloneId: 'A', reason: 'TTL', writer, thresholds: defaultThresholds });
    const r = await ctx.registry.get('A');
    expect(r.state).toBe('DEAD');
    expect(r.death_reason).toContain('TTL');
  });

  it('is idempotent if the clone is already DEAD', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    await ctx.registry.markDead('A', 'manual');
    const writer = inMemoryPostMortemWriter();
    await runPostMortem(ctx, { cloneId: 'A', reason: 'after-the-fact', writer, thresholds: defaultThresholds });
    expect(writer.captured).toHaveLength(1);
  });

  it('propagates writer errors when the filename would be unsafe', async () => {
    // The cloneId itself is not sanitized by the composer; the writer is the
    // last line of defence. This test documents that contract: hostile cloneIds
    // do not escape the post-mortem directory.
    const writer = inMemoryPostMortemWriter();
    // Override write to mimic the fs writer's SAFE_FILENAME guard
    writer.write = async (doc) => {
      if (!/^[A-Za-z0-9._-]+$/.test(doc.filename)) {
        throw new Error(`unsafe filename: ${doc.filename}`);
      }
      writer.captured.push(doc);
      return { path: `mem://${doc.filename}` };
    };
    await ctx.registry.register({
      clone_id: 'AA', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {},
    });
    // Directly call with hostile cloneId — registry.get will throw not-found,
    // which is itself a safety net. Test the writer-level rejection by
    // crafting a registered clone with a hostile cast_id instead:
    await ctx.registry.heartbeat({ clone_id: 'AA', state: 'WORKING' });
    // Replace metadata to inject hostile cast_id; castIdOf strips it down,
    // so this should NOT trigger writer rejection — confirms sanitization works.
    const ok = await runPostMortem(ctx, {
      cloneId: 'AA',
      reason: 'sanitization-check',
      writer,
      thresholds: defaultThresholds,
    });
    expect(writer.captured).toHaveLength(1);
    expect(ok.document.filename).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});
```

- [ ] **1.37: Run failing post-mortem test**

Run: `pnpm --filter @manta/orchestrator test post-mortem.test.ts`
Expected: FAIL — module missing.

- [ ] **1.38: Implement `post-mortem.ts`**

Create `packages/manta-orchestrator/src/post-mortem.ts`:

```typescript
import type { BusContext, BusEvent, CloneRecord } from '@manta/bus';
import type { Thresholds } from './thresholds';
import type { PostMortemWriter, PostMortemDocument } from './post-mortem-writer';

export interface RunPostMortemOptions {
  cloneId: string;
  reason: string;
  writer: PostMortemWriter;
  thresholds: Thresholds;
}

export interface RunPostMortemResult {
  document: PostMortemDocument;
  event: BusEvent;
  path: string;
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

function ymd(epochMs: number): string {
  const d = new Date(epochMs);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function castIdOf(record: CloneRecord): string {
  const cast = record.metadata?.cast_id?.replace(/[^A-Za-z0-9._-]/g, '') ?? '';
  return cast.length > 0 ? cast : 'no-cast';
}

export async function runPostMortem(
  ctx: Pick<BusContext, 'registry' | 'events' | 'clock'>,
  opts: RunPostMortemOptions,
): Promise<RunPostMortemResult> {
  const record = await ctx.registry.get(opts.cloneId);

  // Mark DEAD if not already; preserves the original death_reason on idempotent re-runs.
  let final: CloneRecord = record;
  if (record.state !== 'DEAD') {
    final = await ctx.registry.markDead(opts.cloneId, opts.reason);
  }

  const allEvents = await ctx.events.readAll();
  const cloneEvents = allEvents.filter((e) => e.clone_id === opts.cloneId);

  const day = ymd(ctx.clock.now());
  const cast = castIdOf(final);
  const filename = `${day}-${cast}-${opts.cloneId}.md`;

  const body = renderMarkdown({ record: final, reason: opts.reason, events: cloneEvents, thresholds: opts.thresholds });
  const document: PostMortemDocument = { filename, body };
  const written = await opts.writer.write(document);
  const event = await ctx.events.append({
    type: 'post_mortem',
    clone_id: opts.cloneId,
    payload: { path: written.path, reason: opts.reason },
  });
  return { document, event, path: written.path };
}

interface RenderInput {
  record: CloneRecord;
  reason: string;
  events: BusEvent[];
  thresholds: Thresholds;
}

function renderMarkdown(input: RenderInput): string {
  const lines: string[] = [];
  lines.push(`# Post-mortem — clone ${input.record.clone_id}`);
  lines.push('');
  lines.push(`- Mode: ${input.record.mode}`);
  lines.push(`- Worktree: ${input.record.worktree}`);
  lines.push(`- Parent PID: ${input.record.parent_pid}`);
  lines.push(`- Registered at (epoch ms): ${input.record.registered_at}`);
  lines.push(`- Last heartbeat at (epoch ms): ${input.record.last_heartbeat_at}`);
  lines.push(`- Died at (epoch ms): ${input.record.died_at ?? 'unknown'}`);
  lines.push(`- Final state: ${input.record.state}`);
  lines.push(`- Reason: ${input.reason}`);
  lines.push(`- Recorded death_reason: ${input.record.death_reason ?? '<none>'}`);
  lines.push('');
  if (Object.keys(input.record.metadata).length > 0) {
    lines.push('## Metadata');
    for (const [k, v] of Object.entries(input.record.metadata)) {
      lines.push(`- ${k}: ${v}`);
    }
    lines.push('');
  }
  lines.push('## Thresholds in effect');
  lines.push(`- heartbeatTimeoutMs: ${input.thresholds.heartbeatTimeoutMs}`);
  lines.push(`- staleLockMs: ${input.thresholds.staleLockMs}`);
  lines.push(`- parentPidCheckEnabled: ${input.thresholds.parentPidCheckEnabled}`);
  lines.push('');
  lines.push('## Event timeline');
  if (input.events.length === 0) {
    lines.push('- (no events recorded)');
  } else {
    for (const e of input.events) {
      lines.push(`- \`${e.ts}\` [${e.type}] ${JSON.stringify(e.payload)}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}
```

- [ ] **1.39: Re-run post-mortem test**

Run: `pnpm --filter @manta/orchestrator test post-mortem.test.ts`
Expected: 4/4 passing.

- [ ] **1.40: Write the `index.ts` for Chunk 1 surface**

Create `packages/manta-orchestrator/src/index.ts`:

```typescript
// Re-exports — extended in Chunk 2 with Orchestrator + status types.
export * from './thresholds';
export * from './parent-pid';
export * from './death-detector';
export * from './lock-reaper';
export * from './claim-reaper';
export * from './post-mortem-writer';
export * from './post-mortem';
```

- [ ] **1.41: Run full Chunk-1 test sweep with coverage**

Run: `pnpm --filter @manta/orchestrator test:coverage`
Expected: ALL passing. Coverage ≥ 80 % on every threshold for `src/**/*.ts` excluding `src/index.ts`.

- [ ] **1.42: Lint + typecheck**

Run: `pnpm --filter @manta/orchestrator lint && pnpm --filter @manta/orchestrator typecheck`
Expected: zero errors / warnings.

- [ ] **1.43: Commit Chunk 1 (post-mortem)**

```bash
git -c user.email="tr00x@proton.me" -c user.name="Tim Hunt" add \
  packages/manta-orchestrator/src \
  packages/manta-orchestrator/tests
git -c user.email="tr00x@proton.me" -c user.name="Tim Hunt" commit -m "$(cat <<'EOF'
feat(orchestrator): post-mortem composer + writer (atomic, structured md)

- post-mortem.ts: composes registry record + filtered event timeline,
  renders markdown, idempotent on already-DEAD clones, marks fresh ones
- post-mortem-writer.ts: PostMortemWriter interface; fs (atomic via
  temp+rename, path-traversal guarded) + inMemory (test capture)
- index.ts: Chunk-1 public surface (Orchestrator class lands in Chunk 2)

Coverage ≥ 80% on all paths.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Chunk 2: `Orchestrator` class + cycle integration

**Goal of this chunk:** Compose Chunk 1 into a single class with `runCycle()` semantics, add `getStatus()` snapshot, type errors, and prove end-to-end with an integration test that drives a real `BusContext` from `@manta/bus` through a death event into a written post-mortem and an updated state.

**Files (new):**
- Create: `packages/manta-orchestrator/src/errors.ts`
- Create: `packages/manta-orchestrator/src/status.ts`
- Create: `packages/manta-orchestrator/src/orchestrator.ts`
- Create: `packages/manta-orchestrator/tests/errors.test.ts`
- Create: `packages/manta-orchestrator/tests/status.test.ts`
- Create: `packages/manta-orchestrator/tests/orchestrator.test.ts`
- Create: `packages/manta-orchestrator/tests/integration.test.ts`
- Create: `packages/manta-orchestrator/README.md`
- Create: `packages/manta-orchestrator/ARCHITECTURE.md`
- Modify: `packages/manta-orchestrator/src/index.ts` — add `Orchestrator`, `OrchestratorError`, status exports

**Why these boundaries:**
- `errors.ts` mirrors the bus's typed-errors pattern. `OrchestratorError` carries enough info to map to the bus's event log without losing the original cause.
- `status.ts` is tiny (one shape, one builder) but isolated so callers can serialize it for the CLI's `manta status` command (Phase 0d).
- `orchestrator.ts` ties Chunk-1 pieces together. It does NOT own its own clock/registry/locks — they're injected via `BusContext`. Single dependency in / single function out.
- `integration.test.ts` uses real `@manta/bus` stores (filesystem, no mocks). Proves the cycle works end-to-end against the real wire format.

### Tasks

- [ ] **2.1: Write failing tests for `errors.ts`**

Create `packages/manta-orchestrator/tests/errors.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { OrchestratorError, isOrchestratorError } from '../src/errors';

describe('errors', () => {
  it('OrchestratorError carries kind + cause', () => {
    const cause = new Error('inner');
    const err = new OrchestratorError('post-mortem failed', { kind: 'post_mortem_failed', cause });
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe('post_mortem_failed');
    expect(err.cause).toBe(cause);
    expect(err.name).toBe('OrchestratorError');
  });

  it('isOrchestratorError narrows correctly', () => {
    const err = new OrchestratorError('x', { kind: 'cycle_failed' });
    expect(isOrchestratorError(err)).toBe(true);
    expect(isOrchestratorError(new Error('plain'))).toBe(false);
    expect(isOrchestratorError({ name: 'OrchestratorError' })).toBe(false);
  });
});
```

- [ ] **2.2: Run failing errors test**

Run: `pnpm --filter @manta/orchestrator test errors.test.ts`
Expected: FAIL — module missing.

- [ ] **2.3: Implement `errors.ts`**

Create `packages/manta-orchestrator/src/errors.ts`:

```typescript
export type OrchestratorErrorKind =
  | 'cycle_failed'
  | 'post_mortem_failed'
  | 'death_detect_failed'
  | 'reap_failed';

export class OrchestratorError extends Error {
  readonly kind: OrchestratorErrorKind;
  constructor(message: string, options: { kind: OrchestratorErrorKind; cause?: unknown }) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'OrchestratorError';
    this.kind = options.kind;
  }
}

export function isOrchestratorError(value: unknown): value is OrchestratorError {
  return value instanceof OrchestratorError;
}
```

- [ ] **2.4: Re-run errors test**

Run: `pnpm --filter @manta/orchestrator test errors.test.ts`
Expected: 2/2 passing.

- [ ] **2.5: Write failing tests for `status.ts`**

Create `packages/manta-orchestrator/tests/status.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildStatus } from '../src/status';
import { defaultThresholds } from '../src/thresholds';
import { buildBusContext, type TestBusContext } from './helpers/buildBusContext';

describe('status', () => {
  let ctx: TestBusContext;
  beforeEach(async () => { ctx = await buildBusContext(); });
  afterEach(async () => { await ctx.cleanup(); });

  it('returns empty snapshot when nothing registered', async () => {
    const s = await buildStatus(ctx, { thresholds: defaultThresholds });
    expect(s.now).toBe(1_000_000);
    expect(s.clones).toEqual([]);
    expect(s.locks).toEqual([]);
    expect(s.claims).toEqual([]);
    expect(s.thresholds).toEqual(defaultThresholds);
  });

  it('reports registered clones, locks, claims', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    await ctx.locks.acquire({ clone_id: 'A', path: 'src/foo.ts' });
    await ctx.claims.claim({ clone_id: 'A', item: 'task-1', timeout_ms: 60_000 });
    const s = await buildStatus(ctx, { thresholds: defaultThresholds });
    expect(s.clones.map((c) => c.clone_id)).toEqual(['A']);
    expect(s.locks.map((l) => l.path)).toEqual(['src/foo.ts']);
    expect(s.claims.map((c) => c.item)).toEqual(['task-1']);
  });
});
```

- [ ] **2.6: Run failing status test**

Run: `pnpm --filter @manta/orchestrator test status.test.ts`
Expected: FAIL — module missing.

- [ ] **2.7: Implement `status.ts`**

Create `packages/manta-orchestrator/src/status.ts`:

```typescript
import type { BusContext, CloneRecord, LockLease, WorkClaim } from '@manta/bus';
import type { Thresholds } from './thresholds';

export interface OrchestratorStatus {
  now: number;
  clones: CloneRecord[];
  locks: LockLease[];
  claims: WorkClaim[];
  thresholds: Thresholds;
}

export async function buildStatus(
  ctx: Pick<BusContext, 'registry' | 'locks' | 'claims' | 'clock'>,
  options: { thresholds: Thresholds },
): Promise<OrchestratorStatus> {
  const [clones, locks, claims] = await Promise.all([
    ctx.registry.list(),
    listLeases(ctx),
    ctx.claims.list(),
  ]);
  return {
    now: ctx.clock.now(),
    clones,
    locks,
    claims,
    thresholds: options.thresholds,
  };
}

async function listLeases(ctx: Pick<BusContext, 'locks' | 'registry'>): Promise<LockLease[]> {
  // LocksStore exposes listOwned(cloneId); aggregate across all known clones.
  // (A LocksStore.listAll would be cleaner; defer until Phase 0d when CLI surfaces it.)
  const all = await ctx.registry.list();
  const out: LockLease[] = [];
  for (const c of all) {
    const owned = await ctx.locks.listOwned(c.clone_id);
    out.push(...owned);
  }
  return out;
}
```

> **Bus extension (small):** `LocksStore.listOwned` exists; for accurate status we also need leases owned by clones whose registry record is gone (zombies). Phase 0d will add `LocksStore.listAll`. Until then, this status is correct for live clones — orphan locks surface as `lock_reap` events instead.

- [ ] **2.8: Re-run status test**

Run: `pnpm --filter @manta/orchestrator test status.test.ts`
Expected: 2/2 passing.

- [ ] **2.9: Write failing tests for `orchestrator.ts`**

Create `packages/manta-orchestrator/tests/orchestrator.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Orchestrator } from '../src/orchestrator';
import { defaultThresholds } from '../src/thresholds';
import { makeProbe } from '../src/parent-pid';
import { inMemoryPostMortemWriter } from '../src/post-mortem-writer';
import { buildBusContext, type TestBusContext } from './helpers/buildBusContext';

describe('Orchestrator', () => {
  let ctx: TestBusContext;
  beforeEach(async () => { ctx = await buildBusContext(); });
  afterEach(async () => { await ctx.cleanup(); });

  it('runCycle on empty state is a no-op', async () => {
    const writer = inMemoryPostMortemWriter();
    const o = new Orchestrator({ ctx, thresholds: defaultThresholds, probe: makeProbe({ alive: () => true }), writer });
    const result = await o.runCycle();
    expect(result.deadClones).toEqual([]);
    expect(result.reapedLocks).toEqual([]);
    expect(result.reapedClaims).toEqual([]);
    expect(result.postMortems).toEqual([]);
    expect(writer.captured).toEqual([]);
  });

  it('runCycle marks heartbeat-stale clones DEAD and writes a post-mortem', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: { cast_id: 'cast-1' } });
    ctx.clock.advance(31_000);
    const writer = inMemoryPostMortemWriter();
    const o = new Orchestrator({ ctx, thresholds: defaultThresholds, probe: makeProbe({ alive: () => true }), writer });
    const result = await o.runCycle();
    expect(result.deadClones.map((d) => d.clone_id)).toEqual(['A']);
    expect(writer.captured).toHaveLength(1);
    const r = await ctx.registry.get('A');
    expect(r.state).toBe('DEAD');
  });

  it('runCycle reaps stale locks and emits events', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    await ctx.locks.acquire({ clone_id: 'A', path: 'src/foo.ts' });
    ctx.clock.advance(15_001);
    const writer = inMemoryPostMortemWriter();
    const o = new Orchestrator({ ctx, thresholds: defaultThresholds, probe: makeProbe({ alive: () => true }), writer });
    const result = await o.runCycle();
    expect(result.reapedLocks.map((l) => l.path)).toEqual(['src/foo.ts']);
  });

  it('runCycle reaps expired claims', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    await ctx.claims.claim({ clone_id: 'A', item: 'task-1', timeout_ms: 1_000 });
    ctx.clock.advance(1_001);
    const writer = inMemoryPostMortemWriter();
    const o = new Orchestrator({ ctx, thresholds: defaultThresholds, probe: makeProbe({ alive: () => true }), writer });
    const result = await o.runCycle();
    expect(result.reapedClaims.map((c) => c.item)).toEqual(['task-1']);
  });

  it('runCycle handles parent-PID death even when heartbeat is fresh', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 999, worktree: '/w', metadata: {} });
    ctx.clock.advance(1_000);
    const writer = inMemoryPostMortemWriter();
    const o = new Orchestrator({
      ctx, thresholds: defaultThresholds, probe: makeProbe({ alive: () => false }), writer,
    });
    const result = await o.runCycle();
    expect(result.deadClones.map((d) => d.clone_id)).toEqual(['A']);
    expect(result.deadClones[0].reason).toMatch(/parent/);
  });

  it('runCycle is idempotent when called twice on the same state', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    ctx.clock.advance(31_000);
    const writer = inMemoryPostMortemWriter();
    const o = new Orchestrator({ ctx, thresholds: defaultThresholds, probe: makeProbe({ alive: () => true }), writer });
    const first = await o.runCycle();
    const second = await o.runCycle();
    expect(first.deadClones).toHaveLength(1);
    expect(second.deadClones).toHaveLength(0); // already DEAD on the second pass
    expect(writer.captured).toHaveLength(1);
  });

  it('getStatus returns a coherent snapshot', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    const o = new Orchestrator({
      ctx, thresholds: defaultThresholds, probe: makeProbe({ alive: () => true }), writer: inMemoryPostMortemWriter(),
    });
    const s = await o.getStatus();
    expect(s.clones.map((c) => c.clone_id)).toEqual(['A']);
  });

  it('runCycle wraps unexpected errors in OrchestratorError without leaving partial state', async () => {
    // Simulate failure by injecting a probe that throws inside findDeadClones
    const writer = inMemoryPostMortemWriter();
    const o = new Orchestrator({
      ctx,
      thresholds: defaultThresholds,
      probe: { alive: () => { throw new Error('probe blew up'); } },
      writer,
    });
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    ctx.clock.advance(1_000);
    await expect(o.runCycle()).rejects.toMatchObject({ name: 'OrchestratorError', kind: 'cycle_failed' });

    // Fail-fast contract: nothing visible to a subsequent cycle.
    // Specifically: no lock_reap / claim_reap / post_mortem events emitted,
    // and no post-mortem written. (The probe throws BEFORE reapers run, so
    // findDeadClones is the only step that executed and it produced no
    // observable state mutation.)
    expect(writer.captured).toEqual([]);
    const events = await ctx.events.readAll();
    const types = events.map((e) => e.type);
    expect(types).not.toContain('lock_reap');
    expect(types).not.toContain('claim_reap');
    expect(types).not.toContain('post_mortem');
    // Registry untouched — A is still alive
    expect((await ctx.registry.get('A')).state).not.toBe('DEAD');
  });
});
```

- [ ] **2.10: Run failing orchestrator test**

Run: `pnpm --filter @manta/orchestrator test orchestrator.test.ts`
Expected: FAIL — module missing.

- [ ] **2.11: Implement `orchestrator.ts`**

Create `packages/manta-orchestrator/src/orchestrator.ts`:

```typescript
import type { BusContext, BusEvent, LockLease, WorkClaim } from '@manta/bus';
import type { Thresholds } from './thresholds';
import type { PidProbe } from './parent-pid';
import type { PostMortemWriter } from './post-mortem-writer';
import { findDeadClones, type DeadCloneFinding } from './death-detector';
import { reapLocks } from './lock-reaper';
import { reapClaims } from './claim-reaper';
import { runPostMortem, type RunPostMortemResult } from './post-mortem';
import { buildStatus, type OrchestratorStatus } from './status';
import { OrchestratorError } from './errors';

export interface OrchestratorOptions {
  ctx: BusContext;
  thresholds: Thresholds;
  probe: PidProbe;
  writer: PostMortemWriter;
}

export interface CycleResult {
  ranAt: number;
  deadClones: DeadCloneFinding[];
  reapedLocks: LockLease[];
  reapedClaims: WorkClaim[];
  postMortems: RunPostMortemResult[];
  events: BusEvent[];
}

export class Orchestrator {
  constructor(private readonly opts: OrchestratorOptions) {}

  async runCycle(): Promise<CycleResult> {
    try {
      const ranAt = this.opts.ctx.clock.now();
      const deadClones = await findDeadClones(this.opts.ctx, {
        thresholds: this.opts.thresholds,
        probe: this.opts.probe,
      });
      const lockResult = await reapLocks(this.opts.ctx);
      const claimResult = await reapClaims(this.opts.ctx);
      const postMortems: RunPostMortemResult[] = [];
      for (const dead of deadClones) {
        const pm = await runPostMortem(this.opts.ctx, {
          cloneId: dead.clone_id,
          reason: dead.reason,
          writer: this.opts.writer,
          thresholds: this.opts.thresholds,
        });
        postMortems.push(pm);
      }
      const events = [
        ...lockResult.events,
        ...claimResult.events,
        ...postMortems.map((p) => p.event),
      ];
      return {
        ranAt,
        deadClones,
        reapedLocks: lockResult.reaped,
        reapedClaims: claimResult.reaped,
        postMortems,
        events,
      };
    } catch (err) {
      throw new OrchestratorError('cycle failed', { kind: 'cycle_failed', cause: err });
    }
  }

  async getStatus(): Promise<OrchestratorStatus> {
    return buildStatus(this.opts.ctx, { thresholds: this.opts.thresholds });
  }
}
```

- [ ] **2.12: Re-run orchestrator test**

Run: `pnpm --filter @manta/orchestrator test orchestrator.test.ts`
Expected: 8/8 passing.

- [ ] **2.13: Update `src/index.ts` to export Chunk-2 surface**

`Edit` `packages/manta-orchestrator/src/index.ts` to append:

```typescript
export * from './errors';
export * from './status';
export * from './orchestrator';
```

- [ ] **2.14: Write integration test (real bus, full cycle)**

Create `packages/manta-orchestrator/tests/integration.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Orchestrator } from '../src/orchestrator';
import { defaultThresholds } from '../src/thresholds';
import { makeProbe } from '../src/parent-pid';
import { fsPostMortemWriter } from '../src/post-mortem-writer';
import { buildBusContext, type TestBusContext } from './helpers/buildBusContext';

describe('orchestrator integration (real @manta/bus, real fs)', () => {
  let ctx: TestBusContext;
  beforeEach(async () => { ctx = await buildBusContext(); });
  afterEach(async () => { await ctx.cleanup(); });

  it('detects dead clone, marks DEAD, reaps locks, writes a post-mortem on disk', async () => {
    // 1. Register A and have it heartbeat once, lock a path, claim a work item.
    await ctx.registry.register({
      clone_id: 'A', mode: 'recon-swarm', parent_pid: process.pid,
      worktree: ctx.root, metadata: { cast_id: 'cast-X' },
    });
    await ctx.registry.heartbeat({ clone_id: 'A', state: 'WORKING', progress: 'mid' });
    await ctx.locks.acquire({ clone_id: 'A', path: 'src/index.ts' });
    await ctx.claims.claim({ clone_id: 'A', item: 'analyze', timeout_ms: 60_000 });

    // 2. Time passes — heartbeat goes stale, lock goes stale, claim goes stale.
    ctx.clock.advance(60_001);

    // 3. Run a cycle with a real fs writer.
    const writer = fsPostMortemWriter({ repoRoot: ctx.root, postMortemDir: 'docs/post-mortems' });
    const o = new Orchestrator({
      ctx, thresholds: defaultThresholds, probe: makeProbe({ alive: () => true }), writer,
    });
    const result = await o.runCycle();

    // 4. Assert all four planes acted.
    expect(result.deadClones.map((d) => d.clone_id)).toEqual(['A']);
    expect(result.reapedLocks.map((l) => l.path)).toEqual(['src/index.ts']);
    expect(result.reapedClaims.map((c) => c.item)).toEqual(['analyze']);
    expect(result.postMortems).toHaveLength(1);

    // 5. Disk artifacts exist.
    const pmDir = path.join(ctx.root, 'docs', 'post-mortems');
    const files = await fs.readdir(pmDir);
    expect(files).toHaveLength(1);
    const pmContent = await fs.readFile(path.join(pmDir, files[0]), 'utf8');
    expect(pmContent).toContain('# Post-mortem — clone A');
    expect(pmContent).toContain('cast-X');

    // 6. Bus state reflects death.
    const r = await ctx.registry.get('A');
    expect(r.state).toBe('DEAD');

    // 7. Events log shows lock_reap and claim_reap BEFORE post_mortem
    //    (cycle order: detect → reap-locks → reap-claims → post-mortem).
    //    Asserting indices catches a future refactor that reorders phases.
    const events = await ctx.events.readAll();
    const types = events.map((e) => e.type);
    expect(types).toContain('lock_reap');
    expect(types).toContain('claim_reap');
    expect(types).toContain('post_mortem');
    expect(types.indexOf('post_mortem')).toBeGreaterThan(types.indexOf('lock_reap'));
    expect(types.indexOf('post_mortem')).toBeGreaterThan(types.indexOf('claim_reap'));
  });

  it('does nothing on a healthy state', async () => {
    await ctx.registry.register({
      clone_id: 'A', mode: 'recon-swarm', parent_pid: process.pid,
      worktree: ctx.root, metadata: {},
    });
    const writer = fsPostMortemWriter({ repoRoot: ctx.root, postMortemDir: 'docs/post-mortems' });
    const o = new Orchestrator({
      ctx, thresholds: defaultThresholds, probe: makeProbe({ alive: () => true }), writer,
    });
    const result = await o.runCycle();
    expect(result.deadClones).toEqual([]);
    expect(result.reapedLocks).toEqual([]);
    expect(result.reapedClaims).toEqual([]);
    expect(result.postMortems).toEqual([]);
    // No post-mortem dir created
    await expect(fs.access(path.join(ctx.root, 'docs/post-mortems'))).rejects.toThrow();
  });
});
```

- [ ] **2.15: Run integration test**

Run: `pnpm --filter @manta/orchestrator test integration.test.ts`
Expected: 2/2 passing.

- [ ] **2.16: Run full coverage sweep + lint + typecheck + build**

Run from repo root:
```
pnpm --filter @manta/orchestrator test:coverage && pnpm --filter @manta/orchestrator lint && pnpm --filter @manta/orchestrator typecheck && pnpm --filter @manta/orchestrator build
```
Expected: all green; coverage ≥ 80 % on every threshold for `src/**/*.ts` excluding `src/index.ts`.

- [ ] **2.17: Verify build artifacts**

Run: `ls packages/manta-orchestrator/dist/`
Expected: `index.cjs`, `index.js`, `index.d.ts`. No build errors.

- [ ] **2.18: Write `packages/manta-orchestrator/README.md`**

Use `Write`:

````markdown
# @manta/orchestrator

Lifecycle policy layer for Manta clones — detects dead/zombie clones, reaps stale locks and expired claims, writes structured post-mortems, emits observability events.

## Use

```typescript
import { Orchestrator, defaultThresholds, makeProbe, fsPostMortemWriter } from '@manta/orchestrator';
import { /* build a BusContext */ } from '@manta/bus';

const o = new Orchestrator({
  ctx: busContext,
  thresholds: defaultThresholds,
  probe: makeProbe(),
  writer: fsPostMortemWriter({ repoRoot: '/path/to/repo', postMortemDir: 'docs/post-mortems' }),
});

const result = await o.runCycle();
// result: deadClones, reapedLocks, reapedClaims, postMortems, events
```

Call `runCycle` on a tick (Phase 0d CLI) or in a daemon (Phase 5).

## Triggers

A clone is declared DEAD when any of:

- **Heartbeat staleness** — last heartbeat older than `thresholds.heartbeatTimeoutMs` (default 30 s).
- **Parent process death** — if `thresholds.parentPidCheckEnabled` is true (default), and `process.kill(parent_pid, 0)` reports the parent gone.

Both can fire together; the `reason` string is composite.

> **Phase 0 coverage of spec Sec 7.** The two triggers above collectively map to Sec 7's **TTL**, **Crash**, and **Killed** rows (a clone that ran out of time stops heartbeating; a crashed parent leaves orphans; an externally killed clone stops heartbeating). The **Failure (3 errors)** and **Drift** triggers come from inside the clone (the clone calls `manta.suicide_intent` then `manta.report_death`), and the **Success** path is owned by `manta-merge-review` (Phase 2 forking-realities). All three flow through the bus's existing `report_death` tool, so the orchestrator sees them as already-DEAD records and writes the post-mortem the same way.

## Reapers

- `lock-reaper` — calls `LocksStore.reapStale()`; emits one `lock_reap` event per reaped lease.
- `claim-reaper` — calls `ClaimsStore.reapExpired()`; emits one `claim_reap` event per expired claim.

## Post-mortem

For each newly-DEAD clone, the orchestrator writes `docs/post-mortems/<YYYY-MM-DD>-<cast-id>-<clone-id>.md` with:

- Registry record snapshot (state, parent PID, worktree, last heartbeat)
- Reason string
- Filtered event timeline (only events whose `clone_id` matches)
- Effective thresholds

Post-mortems are atomic (temp-then-rename) and idempotent (safe to call twice — re-runs against an already-DEAD clone still write).

## Status

`getStatus()` returns a snapshot of clones, locks, claims, and the active thresholds. Used by `manta status` (Phase 0d).

## Errors

Cycle failures wrap the cause in `OrchestratorError` with a typed `kind` (`cycle_failed` | `post_mortem_failed` | `death_detect_failed` | `reap_failed`). The original cause is preserved on `.cause` so callers can drill in:

```typescript
import { isOrchestratorError } from '@manta/orchestrator';

try {
  await orchestrator.runCycle();
} catch (err) {
  if (isOrchestratorError(err)) {
    console.error(`[orchestrator] ${err.kind}:`, err.message, '— cause:', err.cause);
    // Decide: retry, alert, escalate. The bus is unchanged; safe to re-call runCycle.
  } else {
    throw err;
  }
}
```

`runCycle` is **fail-fast**: a thrown probe / writer / store error is propagated wrapped, and no half-applied state (events / post-mortems / registry transitions) is left behind for the next cycle to wonder about.

## Non-goals (deferred)

- Daemon-mode runtime (Phase 5) — Phase 0 is library-only
- Charge / cooldown / budget bookkeeping (Phase 3)
- Best-of-N merge review (Phase 2 forking-realities)
- Worktree teardown (Phase 0d manta-cli)
- Notification routing / batching (Phase 11.0+ tiers)
````

- [ ] **2.19: Write `packages/manta-orchestrator/ARCHITECTURE.md`**

Use `Write`:

````markdown
# @manta/orchestrator — Architecture

## Why this package exists

The bus is a passive data plane — it stores facts but doesn't enforce time-based invariants. Heartbeats expire, locks go stale, parent processes die. The orchestrator is the policy layer that watches those facts, decides "this clone is dead," and runs the death workflow (mark DEAD, reap, write post-mortem, emit events). Everything that needs cleanup happens here, not in the bus.

## Boundaries

- **In scope:** dead-clone detection, stale-lock reaping, expired-claim reaping, post-mortem authoring, status snapshot.
- **Out of scope:**
  - Cycle scheduling (caller decides when — CLI tick in Phase 0, daemon in Phase 5)
  - Spawn / kill / abort (manta-cli)
  - Charge / cooldown ledger (Phase 3)
  - Cross-clone merge review (Phase 2)
  - User-facing notifications routing (handled by hooks + status line)

## Module map

| File | Responsibility |
|---|---|
| `thresholds.ts` | Tunable constants (heartbeat timeout, stale-lock cutoff, post-mortem dir, parent-PID toggle); `mergeThresholds` for partial overrides |
| `parent-pid.ts` | `process.kill(pid, 0)` probe + `PidProbe` injection seam for tests |
| `death-detector.ts` | Pure function: registry list + thresholds + probe → `DeadCloneFinding[]` |
| `lock-reaper.ts` | Calls `LocksStore.reapStale`; emits `lock_reap` events |
| `claim-reaper.ts` | Calls `ClaimsStore.reapExpired`; emits `claim_reap` events |
| `post-mortem-writer.ts` | `PostMortemWriter` interface + fs (atomic) and in-memory implementations |
| `post-mortem.ts` | Composes registry record + filtered event timeline; renders markdown; calls writer; idempotent |
| `status.ts` | `OrchestratorStatus` snapshot for `manta status` |
| `orchestrator.ts` | `Orchestrator` class — composes Chunk-1 functions into `runCycle()` |
| `errors.ts` | `OrchestratorError` with typed `kind` |

## Design choices

- **Pure functions wrapped by a class.** Each phase of a cycle (`findDeadClones`, `reapLocks`, `reapClaims`, `runPostMortem`) is a free function that takes only what it needs. The `Orchestrator` class is a thin composer; it exists for ergonomic injection of `probe` + `writer` + `thresholds` once at construction time. Tests can call the free functions directly without instantiating the class.
- **Injectable PidProbe.** Production uses `isProcessAlive` (`process.kill(pid, 0)`); tests pass a stub. Without injection, parent-PID tests would have to spawn real subprocesses, slowing the suite and making CI flaky.
- **Pluggable PostMortemWriter.** Production writes atomic markdown files; tests use `inMemoryPostMortemWriter` for assertions. Same composer in `post-mortem.ts` calls either.
- **Reapers emit events; the bus stays silent.** `LocksStore.reapStale` and `ClaimsStore.reapExpired` mutate state but do not write to the events log — the orchestrator does, so a no-op call (zero reaped) doesn't litter the log.
- **`runCycle` is idempotent on unchanged state.** A second call after the first against the same registry+locks+claims state produces zero new dead clones, zero reaped leases, zero reaped claims, zero post-mortems.
- **`runPostMortem` is re-entrant by design.** Distinct from cycle-idempotency: directly calling `runPostMortem` against an already-DEAD clone *does* write a fresh markdown document (and emits a fresh `post_mortem` event) without re-marking the clone. This is intentional so the CLI's `manta recover --post-mortem A` always produces an artifact even after a previous run, and so the post-mortem composer is decoupled from "is this the first death?" state.
- **No internal scheduling.** The cycle is single-shot. `cycleIntervalMs` is a hint to callers, not a self-driven setInterval. This keeps the orchestrator testable and stops it from owning a process lifecycle that doesn't exist in Phase 0.
- **Errors wrap, don't lose.** `OrchestratorError` carries `cause` so callers can drill into the underlying bus / fs error.

## Test strategy

- **Unit per module** — each Chunk-1 piece has its own suite with `FakeClock` + tmp-dir bus context.
- **Class-level tests** — `orchestrator.test.ts` exercises `runCycle` against the in-memory writer + injected probe, covering empty / heartbeat-stale / parent-dead / idempotent / error-wrap cases.
- **Integration** — `integration.test.ts` runs against a real `@manta/bus` `BusContext` over a tmp dir, with a real `fsPostMortemWriter`. Asserts all four planes: registry transitions, lock reaping, claim reaping, file artifacts on disk, events in the log.
- **Coverage** ≥ 80 % on lines/functions/branches/statements; `src/index.ts` excluded.
````

- [ ] **2.20: Run final sweep**

Run: `pnpm --filter @manta/orchestrator test:coverage && pnpm --filter @manta/orchestrator lint && pnpm --filter @manta/orchestrator typecheck && pnpm --filter @manta/orchestrator build`
Expected: all green.

- [ ] **2.21: (placeholder — INDEX update is a user action, not a worker task)**

The plan reviewer status flip in `docs/superpowers/plans/INDEX.md` (TODO → Approved) is performed by the human after they have read the reviewer report. Worker tasks must not edit INDEX status — that creates a circular self-approval. Skip this task; do not edit INDEX.

- [ ] **2.22: Commit Chunk 2**

```bash
git -c user.email="tr00x@proton.me" -c user.name="Tim Hunt" add \
  packages/manta-orchestrator/src \
  packages/manta-orchestrator/tests \
  packages/manta-orchestrator/README.md \
  packages/manta-orchestrator/ARCHITECTURE.md \
  pnpm-lock.yaml
git -c user.email="tr00x@proton.me" -c user.name="Tim Hunt" commit -m "$(cat <<'EOF'
feat(orchestrator): Orchestrator class + cycle integration

- Orchestrator: composes detection/reapers/post-mortem into runCycle()
- getStatus() snapshot for `manta status` (Phase 0d consumes this)
- OrchestratorError with typed kind, cause-preserving
- Integration test against real @manta/bus + real fs:
  - heartbeat staleness → DEAD + post-mortem + events
  - lock + claim reaping + on-disk markdown artifact
- README + ARCHITECTURE notes (per spec Sec 14.2)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Run: `git log --oneline -5` — verify commit landed.

---

## Plan review checkpoint

After Chunk 2 commits:
1. Dispatch plan-document-reviewer with this plan + the design spec.
2. Apply any blocking feedback.
3. Update INDEX row to `Approved`.

## Hand-off

`@manta/cli` (`phase-0d-cli.md`) consumes:
- `Orchestrator.runCycle()` from a `setInterval` while clones are alive
- `Orchestrator.getStatus()` for `manta status`
- `defaultThresholds` + override path for `--heartbeat-timeout` / `--stale-lock` flags
- `fsPostMortemWriter` for production runs

The skills suite (`phase-0e-skills-and-commands.md`) reads post-mortem markdown output for the `manta-knowledge-harvest` skill (Phase 7+ ZK extraction).
