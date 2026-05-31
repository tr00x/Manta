import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Snapshot } from '@manta/snapshot';
import { TaskContractSchema as BusTaskContractSchema } from '@manta/bus';
import { runCastCommand, toBusContract, validateDisjointPartitions, DAEMON_IDLE_STATES } from '../../src/commands/cast.js';
import { CliError } from '../../src/errors.js';
import {
  runFakeCloneScript,
  type CloneRunner,
} from '../../src/spawner/clone-spawner.js';
import { createReporter, MemorySink, type Reporter } from '../../src/output/reporter.js';
import { createRuntime } from '../../src/runtime.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';
import { makeSnapshotFor } from '../helpers/snapshotFixture.js';
import { parseTasksFile } from '../../src/spawner/tasks-file.js';
import { cloneWorktreePath } from '../../src/spawner/worktree.js';

const noopReporter: Reporter = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'fake-clone.mjs',
);

describe('cast command (recon-swarm)', () => {
  let fx: RepoFixture | undefined;
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  it('spawns N fake clones, ticks, orchestrator detects death, returns 0', async () => {
    fx = await makeRepoFixture();
    // Low heartbeat threshold so the orchestrator's death-detector fires
    // inside the test's tickBudget. The fake-clone default ('crash') exits
    // without marking DEAD, so the orchestrator must do it.
    // parentPidCheckEnabled disabled because fake clone records parent_pid=ppid
    // which is the test runner — disabling avoids cross-test interference.
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: { heartbeatTimeoutMs: 100, startupGraceMs: 100, parentPidCheckEnabled: false },
    });
    const sink = new MemorySink();
    const result = await runCastCommand(rt, {
      mode: 'recon-swarm',
      task: 'map src/',
      cloneCount: 2,
      cycleIntervalMs: 50,
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      reporter: createReporter({ sink }),
      tickBudgetMs: 15_000,
      castId: 'cast-test-1',
      budgetUsdPerClone: 5,
      budgetUsdPerCast: 15,
      verifyMcp: false,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('2');
    // Each clone has a worktree (cast-scoped path — bug #64).
    for (const id of ['A', 'B']) {
      const wt = cloneWorktreePath(fx.root, 'cast-test-1', id);
      const wtExists = await fs
        .access(wt)
        .then(() => true)
        .catch(() => false);
      expect(wtExists).toBe(true);
    }
    // Orchestrator marked them DEAD via the heartbeat-stale path.
    const reg = await rt.ctx.registry.list();
    expect(reg.length).toBe(2);
    expect(reg.every((r) => r.state === 'DEAD')).toBe(true);
    // Cast manifest pins the recon-swarm policy on disk: peer_messaging is
    // 'allowed' (sibling chat permitted), and every roster entry has
    // assignment=null since recon-swarm has no per-clone overlay.
    // Guards against the mode-aware ternary in cast.ts being silently
    // flipped — without this assertion only the forking-realities branch
    // is end-to-end-tested via tests/integration/forking-spawn.test.ts.
    const manifestPath = path.join(fx.root, '.manta', 'state', 'casts', 'cast-test-1.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      mode: string;
      policy: { peer_messaging: string; auto_merge_threshold: number | null };
      clones: Array<{ clone_id: string; assignment: unknown }>;
    };
    expect(manifest.mode).toBe('recon-swarm');
    expect(manifest.policy.peer_messaging).toBe('allowed');
    expect(manifest.policy.auto_merge_threshold).toBeNull();
    expect(manifest.clones.every((c) => c.assignment === null)).toBe(true);
    // Reporter captured key events.
    const events = sink.lines.map((l) => l.event);
    expect(events).toContain('cast.spawn');
    expect(events).toContain('cast.done');
  });

  it('rejects unsupported modes (e.g. council)', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    await expect(
      runCastCommand(rt, {
        // Cast through `unknown` to keep the type-system honest while still
        // exercising the runtime's invalid_input branch for not-yet-allowlisted
        // modes (Phase 2a allows recon-swarm + forking-realities; council
        // is reserved for Phase 8).
        mode: 'council' as unknown as 'recon-swarm',
        task: 't',
        cloneCount: 1,
        cycleIntervalMs: 50,
        runner: runFakeCloneScript({ scriptPath: fixturePath }),
        reporter: createReporter({ sink: new MemorySink() }),
        tickBudgetMs: 5_000,
        castId: 'cast-x',
        budgetUsdPerClone: 5,
        budgetUsdPerCast: 15,
        verifyMcp: false,
      }),
    ).rejects.toMatchObject({ name: 'CliError', kind: 'invalid_input' });
  });

  it('rejects cloneCount < 1 or > 5', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    const base = {
      mode: 'recon-swarm' as const,
      task: 't',
      cycleIntervalMs: 50,
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      reporter: createReporter({ sink: new MemorySink() }),
      tickBudgetMs: 5_000,
      castId: 'cast-x',
      budgetUsdPerClone: 5,
      budgetUsdPerCast: 15,
      verifyMcp: false,
    };
    await expect(runCastCommand(rt, { ...base, cloneCount: 0 })).rejects.toMatchObject({
      kind: 'invalid_input',
    });
    await expect(runCastCommand(rt, { ...base, cloneCount: 6 })).rejects.toMatchObject({
      kind: 'invalid_input',
    });
  });

  it('rejects when cloneCount × budgetUsdPerClone exceeds budgetUsdPerCast (cumulative cost gate)', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    // 5 × $5 = $25 > $15 cap → reject before spawn.
    await expect(
      runCastCommand(rt, {
        mode: 'recon-swarm',
        task: 't',
        cloneCount: 5,
        cycleIntervalMs: 50,
        runner: runFakeCloneScript({ scriptPath: fixturePath }),
        reporter: createReporter({ sink: new MemorySink() }),
        tickBudgetMs: 5_000,
        castId: 'cast-x',
        budgetUsdPerClone: 5,
        budgetUsdPerCast: 15,
        verifyMcp: false,
      }),
    ).rejects.toMatchObject({
      kind: 'invalid_input',
      message: expect.stringContaining('cumulative budget') as unknown as string,
    });
  });

  // I-IMP-1 regression: when a mid-cast spawn step throws (clone N-of-M fails
  // to start), the catch block must terminate already-running children AND
  // peel back the worktrees they created. Otherwise a re-cast collides on
  // `clone-${castId}-${id}` paths and `manta/${castId}/${id}` branch names.
  it('cleans up partial worktrees when a clone fails to spawn mid-cast', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: { heartbeatTimeoutMs: 100, startupGraceMs: 100, parentPidCheckEnabled: false },
    });
    // 2nd invocation throws synchronously from runner.run() — that surfaces
    // out of spawnClone → cast's try-block → the catch must terminate the
    // 1st handle AND remove its worktree.
    let calls = 0;
    const realRunner = runFakeCloneScript({ scriptPath: fixturePath });
    const flakyRunner: CloneRunner = {
      run(input) {
        calls += 1;
        if (calls === 2) {
          throw new Error('synthetic spawn failure on 2nd clone');
        }
        return realRunner.run(input);
      },
    };
    await expect(
      runCastCommand(rt, {
        mode: 'recon-swarm',
        task: 't',
        cloneCount: 2,
        cycleIntervalMs: 50,
        runner: flakyRunner,
        reporter: createReporter({ sink: new MemorySink() }),
        tickBudgetMs: 5_000,
        castId: 'cast-imp1',
        budgetUsdPerClone: 5,
        budgetUsdPerCast: 15,
        verifyMcp: false,
      }),
    ).rejects.toMatchObject({ name: 'CliError', kind: 'cast_failed' });
    // 1st clone's worktree must NOT remain on disk after the failed cast.
    const wtA = cloneWorktreePath(fx.root, 'cast-imp1', 'A');
    const aExists = await fs
      .access(wtA)
      .then(() => true)
      .catch(() => false);
    expect(aExists).toBe(false);
    // 2nd clone never had its worktree created (runner.run threw before
    // spawnClone returned a handle, but addWorktree had already run for B
    // before runner.run was called) — verify it is also gone.
    const wtB = cloneWorktreePath(fx.root, 'cast-imp1', 'B');
    const bExists = await fs
      .access(wtB)
      .then(() => true)
      .catch(() => false);
    expect(bExists).toBe(false);
  });

  // I-IMP-3 regression: tickBudgetMs must bound cast wall-time even when
  // children hang. With heartbeatTimeoutMs raised to ~unreachable, the only
  // stop signal is the budget-timer. The cast must terminate the surviving
  // hung children when the loop aborts (cast.ts I-IMP-3 branch), not wait on
  // `h.exit` which would never resolve for a `hang` fake-clone.
  it('aborts a hung cast when tickBudgetMs elapses (terminates surviving handles)', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({
      repoRoot: fx.root,
      // Heartbeat detector effectively disabled — only the budget-timer can
      // stop this cast. Without I-IMP-3's cleanup branch the call would hang.
      thresholdOverrides: {
        heartbeatTimeoutMs: 99_999,
        startupGraceMs: 99_999,
        parentPidCheckEnabled: false,
      },
    });
    const sink = new MemorySink();
    const start = Date.now();
    const result = await runCastCommand(rt, {
      mode: 'recon-swarm',
      task: 't',
      cloneCount: 1,
      cycleIntervalMs: 50,
      // Hang fake-clone — registers WORKING, then setInterval forever.
      runner: runFakeCloneScript({
        scriptPath: fixturePath,
        env: { MANTA_FAKE_CLONE_STATE: 'hang' },
      }),
      reporter: createReporter({ sink }),
      tickBudgetMs: 200,
      castId: 'cast-imp3',
      budgetUsdPerClone: 5,
      budgetUsdPerCast: 15,
      verifyMcp: false,
    });
    const elapsed = Date.now() - start;
    // Budget is 200ms; SIGTERM grace is 1_000ms; spawn + finally adds slack.
    // 5_000ms is comfortably above the worst-case ladder, well under the
    // 99_999ms heartbeat timeout — so passing this bound proves the budget
    // (not the heartbeat detector) is what stopped the cast.
    expect(elapsed).toBeLessThan(5_000);
    expect(result.exitCode).toBe(0);
    // Reporter recorded the budget-abort event so operators see WHY a cast
    // returned without all clones marking DEAD.
    const events = sink.lines.map((l) => l.event);
    expect(events).toContain('cast.budget_abort');
    expect(events).toContain('cast.done');
  });

  it('force-terminates wedged OS processes after reaper marks DEAD (bug #40)', async () => {
    // The orchestrator's reaper only updates registry state (DEAD); it does
    // NOT signal the OS process. Pre-fix, a wedged `claude --print` (hang
    // fake) would be marked DEAD by the heartbeat detector, allDone() would
    // return true (all DEAD), the loop would exit, and then the cast's
    // `await h.exit` would hang forever waiting on the still-running child
    // — orphan zombie holding the worktree and emitting rejected bus calls.
    // Post-fix, cast.ts walks the registry after the loop, finds the DEAD
    // clone, and force-terminates its handle before reap. The test pins
    // this by using a budget large enough that the budget-abort path
    // CANNOT be what stops the cast — only the DEAD-terminate branch can.
    fx = await makeRepoFixture();
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: {
        heartbeatTimeoutMs: 500,    // reaper marks DEAD fast
        startupGraceMs: 5_000,
        parentPidCheckEnabled: false,
      },
    });
    const sink = new MemorySink();
    const start = Date.now();
    const result = await runCastCommand(rt, {
      mode: 'recon-swarm',
      task: 't',
      cloneCount: 1,
      cycleIntervalMs: 50,
      runner: runFakeCloneScript({
        scriptPath: fixturePath,
        env: { MANTA_FAKE_CLONE_STATE: 'hang' },
      }),
      reporter: createReporter({ sink }),
      tickBudgetMs: 60_000,  // 60s — far longer than the DEAD-terminate path
      castId: 'cast-bug40',
      budgetUsdPerClone: 5,
      budgetUsdPerCast: 15,
      verifyMcp: false,
    });
    const elapsed = Date.now() - start;
    // Expected timeline: ~500ms heartbeat stale → DEAD → next cycle allDone
    // true → loop exit → my fix terminates DEAD handle (SIGTERM, 1s grace)
    // → exit resolves → cast returns. ~2s typical, generous 15s bound for CI.
    expect(elapsed).toBeLessThan(15_000);
    expect(result.exitCode).toBe(0);
    const events = sink.lines.map((l) => l.event);
    expect(events).toContain('cast.done');
    // Critical: the DEAD-terminate branch — NOT the budget-abort — is what
    // stopped the cast. If budget_abort fired, the bug is not fixed.
    expect(events).not.toContain('cast.budget_abort');
  });

  it('writes the task contract (translated to bus snake_case schema) before spawning', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: { heartbeatTimeoutMs: 100, startupGraceMs: 100, parentPidCheckEnabled: false },
    });
    await runCastCommand(rt, {
      mode: 'recon-swarm',
      task: 'audit auth',
      cloneCount: 1,
      cycleIntervalMs: 50,
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      reporter: createReporter({ sink: new MemorySink() }),
      tickBudgetMs: 15_000,
      castId: 'cast-c',
      budgetUsdPerClone: 5,
      budgetUsdPerCast: 15,
      verifyMcp: false,
    });
    const stored = await rt.ctx.contracts.read('A');
    // bus.TaskContract uses snake_case fields. The cast command translates
    // from snapshot.taskContract (camelCase) — this test pins the wire shape
    // so a future drift is caught at the boundary.
    expect(stored.contract.clone_id).toBe('A');
    expect(stored.contract.mode).toBe('recon-swarm');
    expect(stored.contract.task).toBe('audit auth');
    expect(stored.contract.deadline_ms).toBeGreaterThan(0);
    expect(stored.contract.scope.allowed_paths).toContain('.');
  });

  it('propagates custom scope (bug #6 fix) into the stored task contract', async () => {
    // Bug #6 (Phase-2 dogfood): cast hardcoded `max_files_changed: 0` so any
    // cast that produces a deliverable file was impossible. Fix exposes scope
    // via CLI flags; this test pins the new RunCastOptions.scope wiring against
    // the bus's snake_case contract.
    fx = await makeRepoFixture();
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: { heartbeatTimeoutMs: 100, startupGraceMs: 100, parentPidCheckEnabled: false },
    });
    await runCastCommand(rt, {
      mode: 'recon-swarm',
      task: 'produce docs/research/x.md',
      cloneCount: 1,
      cycleIntervalMs: 50,
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      reporter: createReporter({ sink: new MemorySink() }),
      tickBudgetMs: 15_000,
      castId: 'cast-scope',
      budgetUsdPerClone: 5,
      budgetUsdPerCast: 15,
      scope: {
        allowedPaths: ['.', 'docs/research/'],
        forbiddenPaths: ['.manta/state', 'secrets/', 'src/'],
        maxFilesChanged: 5,
      },
      verifyMcp: false,
    });
    const stored = await rt.ctx.contracts.read('A');
    expect(stored.contract.scope.allowed_paths).toEqual(['.', 'docs/research/']);
    expect(stored.contract.scope.forbidden_paths).toEqual([
      '.manta/state',
      'secrets/',
      'src/',
    ]);
    expect(stored.contract.scope.max_files_changed).toBe(5);
  });

  it('rejects negative max_files_changed and empty allowed_paths', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    const baseArgs = {
      mode: 'recon-swarm' as const,
      task: 't',
      cloneCount: 1,
      cycleIntervalMs: 50,
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      reporter: createReporter({ sink: new MemorySink() }),
      tickBudgetMs: 15_000,
      castId: 'cast-neg',
      budgetUsdPerClone: 5,
      budgetUsdPerCast: 15,
      verifyMcp: false,
    };
    await expect(
      runCastCommand(rt, {
        ...baseArgs,
        scope: { allowedPaths: ['.'], forbiddenPaths: [], maxFilesChanged: -1 },
      }),
    ).rejects.toMatchObject({ name: 'CliError', kind: 'invalid_input' });
    await expect(
      runCastCommand(rt, {
        ...baseArgs,
        scope: { allowedPaths: [], forbiddenPaths: [], maxFilesChanged: 0 },
      }),
    ).rejects.toMatchObject({ name: 'CliError', kind: 'invalid_input' });
  });
});

describe('cast command (forking-realities allowlist + per-clone overlay)', () => {
  let fx: RepoFixture | undefined;
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  it('accepts forking-realities mode (Phase 2a)', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: {
        heartbeatTimeoutMs: 100,
        startupGraceMs: 100,
        parentPidCheckEnabled: false,
      },
    });
    const result = await runCastCommand(rt, {
      mode: 'forking-realities',
      task: 'placeholder',
      cloneCount: 2,
      cycleIntervalMs: 50,
      tickBudgetMs: 5_000,
      castId: 'cast-test-fr-1',
      budgetUsdPerClone: 1,
      budgetUsdPerCast: 5,
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      reporter: noopReporter,
      verifyMcp: false,
    });
    expect(result.exitCode).toBe(0);
  });

  it('overlays per-clone task / approachHint from cloneAssignments', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: {
        heartbeatTimeoutMs: 100,
        startupGraceMs: 100,
        parentPidCheckEnabled: false,
      },
    });
    const realRunner = runFakeCloneScript({ scriptPath: fixturePath });
    const captured: Snapshot[] = [];
    const recordingRunner: CloneRunner = {
      run(input) {
        const raw = readFileSync(input.env.MANTA_SNAPSHOT_PATH!, 'utf-8');
        captured.push(JSON.parse(raw) as Snapshot);
        return realRunner.run(input);
      },
    };
    await runCastCommand(rt, {
      mode: 'forking-realities',
      task: 'cast-default task',
      cloneCount: 2,
      cycleIntervalMs: 50,
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
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    // Two clones at $4 each = $8 total; cap = $7 → must reject.
    await expect(
      runCastCommand(rt, {
        mode: 'forking-realities',
        task: 'x',
        cloneCount: 2,
        cycleIntervalMs: 50,
        tickBudgetMs: 5_000,
        castId: 'cast-test-asym-1',
        budgetUsdPerClone: 1, // cast-level default
        budgetUsdPerCast: 7,
        cloneAssignments: {
          A: { task: 'a', budget_usd: 4 },
          B: { task: 'b', budget_usd: 4 },
        },
        runner: runFakeCloneScript({ scriptPath: fixturePath }),
        reporter: noopReporter,
        verifyMcp: false,
      }),
    ).rejects.toMatchObject({
      kind: 'invalid_input',
      message: expect.stringMatching(/cumulative budget.*\$8.*exceeds.*\$7/) as unknown as string,
    });
  });

  it('falls back to cast-level defaults when an assignment is missing for a clone', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: {
        heartbeatTimeoutMs: 100,
        startupGraceMs: 100,
        parentPidCheckEnabled: false,
      },
    });
    const realRunner = runFakeCloneScript({ scriptPath: fixturePath });
    const captured: Snapshot[] = [];
    const recordingRunner: CloneRunner = {
      run(input) {
        const raw = readFileSync(input.env.MANTA_SNAPSHOT_PATH!, 'utf-8');
        captured.push(JSON.parse(raw) as Snapshot);
        return realRunner.run(input);
      },
    };
    await runCastCommand(rt, {
      mode: 'forking-realities',
      task: 'cast-level fallback task',
      cloneCount: 3,
      cycleIntervalMs: 50,
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
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    await expect(
      runCastCommand(rt, {
        mode: 'forking-realities',
        task: 'x',
        cloneCount: 2, // roster is [A, B]
        cycleIntervalMs: 50,
        tickBudgetMs: 5_000,
        castId: 'cast-test-typo-1',
        budgetUsdPerClone: 1,
        budgetUsdPerCast: 5,
        cloneAssignments: {
          A: { task: 'a' },
          Z: { task: 'typo — Z is not in roster' },
        },
        runner: runFakeCloneScript({ scriptPath: fixturePath }),
        reporter: noopReporter,
        verifyMcp: false,
      }),
    ).rejects.toMatchObject({
      kind: 'invalid_input',
      message: expect.stringContaining('Z') as unknown as string,
    });
  });

  it('parses --tasks YAML at the CLI seam and applies it through runCastCommand', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: {
        heartbeatTimeoutMs: 100,
        startupGraceMs: 100,
        parentPidCheckEnabled: false,
      },
    });
    const dir = mkdtempSync(join(tmpdir(), 'manta-cli-tasks-'));
    try {
      const f = join(dir, 'plan.yaml');
      writeFileSync(f, `A:\n  task: A-from-yaml\nB:\n  task: B-from-yaml\n`);
      const cloneAssignments = parseTasksFile(f);
      const realRunner = runFakeCloneScript({ scriptPath: fixturePath });
      const captured: Snapshot[] = [];
      const recordingRunner: CloneRunner = {
        run(input) {
          const raw = readFileSync(input.env.MANTA_SNAPSHOT_PATH!, 'utf-8');
          captured.push(JSON.parse(raw) as Snapshot);
          return realRunner.run(input);
        },
      };
      const result = await runCastCommand(rt, {
        mode: 'forking-realities',
        task: 'cast-default-ignored',
        cloneCount: 2,
        cycleIntervalMs: 50,
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
});

describe('toBusContract — snapshot ↔ bus approach_hint translation drift', () => {
  it('elides approach_hint when snapshot.approachHint is null', () => {
    const snap = makeSnapshotFor({ cloneId: 'A', approachHint: null });
    const bus = toBusContract(snap);
    expect(BusTaskContractSchema.parse(bus)).toBeDefined(); // round-trips through bus zod
    expect((bus as { approach_hint?: string }).approach_hint).toBeUndefined();
  });

  it('sets approach_hint when snapshot.approachHint is non-null', () => {
    const snap = makeSnapshotFor({ cloneId: 'A', approachHint: 'use an index' });
    const bus = toBusContract(snap);
    expect((bus as { approach_hint?: string }).approach_hint).toBe('use an index');
  });

  it('round-trips a non-null approachHint through bus zod', () => {
    const snap = makeSnapshotFor({ cloneId: 'A', approachHint: 'denormalize' });
    const bus = BusTaskContractSchema.parse(toBusContract(snap));
    expect(bus.approach_hint).toBe('denormalize');
  });
});

describe('cast command — bug-hunt mode', () => {
  let fx: RepoFixture | undefined;
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  it('accepts bug-hunt as valid mode', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: {
        heartbeatTimeoutMs: 100,
        startupGraceMs: 100,
        parentPidCheckEnabled: false,
      },
    });
    const result = await runCastCommand(rt, {
      mode: 'bug-hunt' as unknown as 'recon-swarm',
      task: 'investigate auth timeout in src/auth.ts',
      cloneCount: 2,
      cycleIntervalMs: 50,
      tickBudgetMs: 15_000,
      castId: 'cast-bh-valid-1',
      budgetUsdPerClone: 5,
      budgetUsdPerCast: 15,
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      reporter: createReporter({ sink: new MemorySink() }),
      verifyMcp: false,
    });
    expect(result.exitCode).toBe(0);
  });

  it('rejects bug-hunt with cloneCount > 2', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    await expect(
      runCastCommand(rt, {
        mode: 'bug-hunt' as unknown as 'recon-swarm',
        task: 'investigate leak',
        cloneCount: 3,
        cycleIntervalMs: 50,
        tickBudgetMs: 5_000,
        castId: 'cast-bh-reject-3',
        budgetUsdPerClone: 5,
        budgetUsdPerCast: 15,
        runner: runFakeCloneScript({ scriptPath: fixturePath }),
        reporter: createReporter({ sink: new MemorySink() }),
        verifyMcp: false,
      }),
    ).rejects.toMatchObject({ name: 'CliError', kind: 'invalid_input' });
  });

  it('sets peer_messaging = allowed', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: {
        heartbeatTimeoutMs: 100,
        startupGraceMs: 100,
        parentPidCheckEnabled: false,
      },
    });
    await runCastCommand(rt, {
      mode: 'bug-hunt' as unknown as 'recon-swarm',
      task: 'investigate NPE',
      cloneCount: 2,
      cycleIntervalMs: 50,
      tickBudgetMs: 15_000,
      castId: 'cast-bh-policy-1',
      budgetUsdPerClone: 5,
      budgetUsdPerCast: 15,
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      reporter: createReporter({ sink: new MemorySink() }),
      verifyMcp: false,
    });
    const manifestPath = path.join(fx.root, '.manta', 'state', 'casts', 'cast-bh-policy-1.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      mode: string;
      policy: { peer_messaging: string };
    };
    expect(manifest.policy.peer_messaging).toBe('allowed');
  });

  it('does not trigger merge-review after cast', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: {
        heartbeatTimeoutMs: 100,
        startupGraceMs: 100,
        parentPidCheckEnabled: false,
      },
    });
    const sink = new MemorySink();
    await runCastCommand(rt, {
      mode: 'bug-hunt' as unknown as 'recon-swarm',
      task: 'investigate timeout',
      cloneCount: 1,
      cycleIntervalMs: 50,
      tickBudgetMs: 15_000,
      castId: 'cast-bh-nomerge-1',
      budgetUsdPerClone: 5,
      budgetUsdPerCast: 15,
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      reporter: createReporter({ sink }),
      verifyMcp: false,
    });
    const events = sink.lines.map((l) => l.event);
    expect(events).not.toContain('cast.merge_review');
    expect(events).not.toContain('cast.merge_review_failed');
  });

  it('reports investigation report paths', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: {
        heartbeatTimeoutMs: 100,
        startupGraceMs: 100,
        parentPidCheckEnabled: false,
      },
    });
    const sink = new MemorySink();
    await runCastCommand(rt, {
      mode: 'bug-hunt' as unknown as 'recon-swarm',
      task: 'investigate OOM',
      cloneCount: 2,
      cycleIntervalMs: 50,
      tickBudgetMs: 15_000,
      castId: 'cast-bh-report-1',
      budgetUsdPerClone: 5,
      budgetUsdPerCast: 15,
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      reporter: createReporter({ sink }),
      verifyMcp: false,
    });
    const events = sink.lines.map((l) => l.event);
    expect(events).toContain('cast.bug-hunt-complete');
    const bhEvent = sink.lines.find((l) => l.event === 'cast.bug-hunt-complete');
    expect(bhEvent?.payload).toHaveProperty('cast', 'cast-bh-report-1');
  });
});

describe('cast command — refactor-wave mode', () => {
  let fx: RepoFixture | undefined;
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  it('accepts refactor-wave as valid mode', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: {
        heartbeatTimeoutMs: 100,
        startupGraceMs: 100,
        parentPidCheckEnabled: false,
      },
    });
    const result = await runCastCommand(rt, {
      mode: 'refactor-wave' as unknown as 'recon-swarm',
      task: 'migrate all error classes to Result<T>',
      cloneCount: 2,
      cycleIntervalMs: 50,
      tickBudgetMs: 15_000,
      castId: 'cast-rw-valid-1',
      budgetUsdPerClone: 5,
      budgetUsdPerCast: 15,
      cloneAssignments: {
        A: {
          task: 'migrate packages/auth',
          scope: { allowed_paths: ['packages/auth'], forbidden_paths: ['.manta/state', 'secrets/'], max_files_changed: 10 },
        },
        B: {
          task: 'migrate packages/billing',
          scope: { allowed_paths: ['packages/billing'], forbidden_paths: ['.manta/state', 'secrets/'], max_files_changed: 10 },
        },
      },
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      reporter: createReporter({ sink: new MemorySink() }),
      verifyMcp: false,
    });
    expect(result.exitCode).toBe(0);
  });

  it('requires cloneAssignments (rejects without --tasks)', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    await expect(
      runCastCommand(rt, {
        mode: 'refactor-wave' as unknown as 'recon-swarm',
        task: 'migrate errors',
        cloneCount: 2,
        cycleIntervalMs: 50,
        tickBudgetMs: 5_000,
        castId: 'cast-rw-no-tasks',
        budgetUsdPerClone: 5,
        budgetUsdPerCast: 15,
        runner: runFakeCloneScript({ scriptPath: fixturePath }),
        reporter: createReporter({ sink: new MemorySink() }),
        verifyMcp: false,
      }),
    ).rejects.toMatchObject({
      name: 'CliError',
      kind: 'invalid_input',
      message: expect.stringContaining('--tasks') as unknown as string,
    });
  });

  it('rejects overlapping partitions', () => {
    expect(() =>
      validateDisjointPartitions({
        A: {
          task: 'a',
          scope: { allowed_paths: ['src/auth'], forbidden_paths: [], max_files_changed: 5 },
        },
        B: {
          task: 'b',
          scope: { allowed_paths: ['src/auth'], forbidden_paths: [], max_files_changed: 5 },
        },
      }),
    ).toThrow(/Overlapping partition.*src\/auth/);
  });

  it('rejects prefix-nested partitions', () => {
    expect(() =>
      validateDisjointPartitions({
        A: {
          task: 'a',
          scope: { allowed_paths: ['src/auth/'], forbidden_paths: [], max_files_changed: 5 },
        },
        B: {
          task: 'b',
          scope: { allowed_paths: ['src/auth/login/'], forbidden_paths: [], max_files_changed: 5 },
        },
      }),
    ).toThrow(/Nested partition overlap/);
  });

  it('sets peer_messaging = denied', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: {
        heartbeatTimeoutMs: 100,
        startupGraceMs: 100,
        parentPidCheckEnabled: false,
      },
    });
    await runCastCommand(rt, {
      mode: 'refactor-wave' as unknown as 'recon-swarm',
      task: 'migrate errors',
      cloneCount: 2,
      cycleIntervalMs: 50,
      tickBudgetMs: 15_000,
      castId: 'cast-rw-policy-1',
      budgetUsdPerClone: 5,
      budgetUsdPerCast: 15,
      cloneAssignments: {
        A: {
          task: 'migrate packages/auth',
          scope: { allowed_paths: ['packages/auth'], forbidden_paths: ['.manta/state'], max_files_changed: 10 },
        },
        B: {
          task: 'migrate packages/billing',
          scope: { allowed_paths: ['packages/billing'], forbidden_paths: ['.manta/state'], max_files_changed: 10 },
        },
      },
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      reporter: createReporter({ sink: new MemorySink() }),
      verifyMcp: false,
    });
    const manifestPath = path.join(fx.root, '.manta', 'state', 'casts', 'cast-rw-policy-1.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      mode: string;
      policy: { peer_messaging: string };
    };
    expect(manifest.policy.peer_messaging).toBe('denied');
  });

  it('triggers merge-all after cast (not merge-review)', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: {
        heartbeatTimeoutMs: 100,
        startupGraceMs: 100,
        parentPidCheckEnabled: false,
      },
    });
    const sink = new MemorySink();
    await runCastCommand(rt, {
      mode: 'refactor-wave' as unknown as 'recon-swarm',
      task: 'migrate errors',
      cloneCount: 2,
      cycleIntervalMs: 50,
      tickBudgetMs: 15_000,
      castId: 'cast-rw-merge-1',
      budgetUsdPerClone: 5,
      budgetUsdPerCast: 15,
      cloneAssignments: {
        A: {
          task: 'migrate packages/auth',
          scope: { allowed_paths: ['packages/auth'], forbidden_paths: ['.manta/state'], max_files_changed: 10 },
        },
        B: {
          task: 'migrate packages/billing',
          scope: { allowed_paths: ['packages/billing'], forbidden_paths: ['.manta/state'], max_files_changed: 10 },
        },
      },
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      reporter: createReporter({ sink }),
      verifyMcp: false,
    });
    const events = sink.lines.map((l) => l.event);
    expect(events).not.toContain('cast.merge_review');
    // merge-all triggers but may fail (Clone A's runMergeAll not in this worktree);
    // either cast.merge-all or cast.merge-all-failed is acceptable before merge
    const hasMergeAll = events.includes('cast.merge-all') || events.includes('cast.merge-all-failed');
    expect(hasMergeAll).toBe(true);
  });
});

describe('cast command — Wave 2 daemon modes', () => {
  let fx: RepoFixture | undefined;
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  it('accepts pair-programming as valid mode', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: {
        heartbeatTimeoutMs: 100,
        startupGraceMs: 100,
        parentPidCheckEnabled: false,
      },
    });
    const result = await runCastCommand(rt, {
      mode: 'pair-programming' as unknown as 'recon-swarm',
      task: 'implement auth module',
      cloneCount: 2,
      cycleIntervalMs: 50,
      tickBudgetMs: 15_000,
      castId: 'cast-pp-valid-1',
      budgetUsdPerClone: 5,
      budgetUsdPerCast: 15,
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      reporter: createReporter({ sink: new MemorySink() }),
      verifyMcp: false,
    });
    expect(result.exitCode).toBe(0);
  });

  it('accepts test-storm as valid mode', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: {
        heartbeatTimeoutMs: 100,
        startupGraceMs: 100,
        parentPidCheckEnabled: false,
      },
    });
    const result = await runCastCommand(rt, {
      mode: 'test-storm' as unknown as 'recon-swarm',
      task: 'write tests for auth',
      cloneCount: 3,
      cycleIntervalMs: 50,
      tickBudgetMs: 15_000,
      castId: 'cast-ts-valid-1',
      budgetUsdPerClone: 5,
      budgetUsdPerCast: 15,
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      reporter: createReporter({ sink: new MemorySink() }),
      verifyMcp: false,
    });
    expect(result.exitCode).toBe(0);
  });

  it('accepts documentation-chase as valid mode', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: {
        heartbeatTimeoutMs: 100,
        startupGraceMs: 100,
        parentPidCheckEnabled: false,
      },
    });
    const result = await runCastCommand(rt, {
      mode: 'documentation-chase' as unknown as 'recon-swarm',
      task: 'document API',
      cloneCount: 2,
      cycleIntervalMs: 50,
      tickBudgetMs: 15_000,
      castId: 'cast-dc-valid-1',
      budgetUsdPerClone: 5,
      budgetUsdPerCast: 15,
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      reporter: createReporter({ sink: new MemorySink() }),
      verifyMcp: false,
    });
    expect(result.exitCode).toBe(0);
  });

  it('pair-programming requires exactly 2 clones', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    await expect(
      runCastCommand(rt, {
        mode: 'pair-programming' as unknown as 'recon-swarm',
        task: 'impl',
        cloneCount: 3,
        cycleIntervalMs: 50,
        tickBudgetMs: 5_000,
        castId: 'cast-pp-reject-3',
        budgetUsdPerClone: 5,
        budgetUsdPerCast: 15,
        runner: runFakeCloneScript({ scriptPath: fixturePath }),
        reporter: createReporter({ sink: new MemorySink() }),
        verifyMcp: false,
      }),
    ).rejects.toMatchObject({ name: 'CliError', kind: 'invalid_input' });
  });

  it('test-storm requires 2-3 clones', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    await expect(
      runCastCommand(rt, {
        mode: 'test-storm' as unknown as 'recon-swarm',
        task: 'tests',
        cloneCount: 4,
        cycleIntervalMs: 50,
        tickBudgetMs: 5_000,
        castId: 'cast-ts-reject-4',
        budgetUsdPerClone: 5,
        budgetUsdPerCast: 20,
        runner: runFakeCloneScript({ scriptPath: fixturePath }),
        reporter: createReporter({ sink: new MemorySink() }),
        verifyMcp: false,
      }),
    ).rejects.toMatchObject({ name: 'CliError', kind: 'invalid_input' });
  });

  it('daemon modes set session_mode = daemon on castPolicy', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: {
        heartbeatTimeoutMs: 100,
        startupGraceMs: 100,
        parentPidCheckEnabled: false,
      },
    });
    await runCastCommand(rt, {
      mode: 'pair-programming' as unknown as 'recon-swarm',
      task: 'impl auth',
      cloneCount: 2,
      cycleIntervalMs: 50,
      tickBudgetMs: 15_000,
      castId: 'cast-pp-policy-1',
      budgetUsdPerClone: 5,
      budgetUsdPerCast: 15,
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      reporter: createReporter({ sink: new MemorySink() }),
      verifyMcp: false,
    });
    const manifestPath = path.join(fx.root, '.manta', 'state', 'casts', 'cast-pp-policy-1.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      mode: string;
      policy: { session_mode: string; peer_messaging: string };
    };
    expect(manifest.policy.session_mode).toBe('daemon');
    expect(manifest.policy.peer_messaging).toBe('allowed');
  });

  it('daemon modes generate sessionId in snapshot', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: {
        heartbeatTimeoutMs: 100,
        startupGraceMs: 100,
        parentPidCheckEnabled: false,
      },
    });
    const realRunner = runFakeCloneScript({ scriptPath: fixturePath });
    const captured: Snapshot[] = [];
    const recordingRunner: CloneRunner = {
      run(input) {
        const raw = readFileSync(input.env.MANTA_SNAPSHOT_PATH!, 'utf-8');
        captured.push(JSON.parse(raw) as Snapshot);
        return realRunner.run(input);
      },
    };
    await runCastCommand(rt, {
      mode: 'pair-programming' as unknown as 'recon-swarm',
      task: 'impl auth',
      cloneCount: 2,
      cycleIntervalMs: 50,
      tickBudgetMs: 15_000,
      castId: 'cast-pp-sid-1',
      budgetUsdPerClone: 5,
      budgetUsdPerCast: 15,
      runner: recordingRunner,
      reporter: createReporter({ sink: new MemorySink() }),
      verifyMcp: false,
    });
    for (const snap of captured) {
      expect(snap.sessionMode).toBe('daemon');
      expect(snap.sessionId).toBeDefined();
      expect(snap.sessionId!.length).toBeGreaterThan(0);
    }
  });

  it('batch modes leave sessionMode = batch (regression)', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: {
        heartbeatTimeoutMs: 100,
        startupGraceMs: 100,
        parentPidCheckEnabled: false,
      },
    });
    const realRunner = runFakeCloneScript({ scriptPath: fixturePath });
    const captured: Snapshot[] = [];
    const recordingRunner: CloneRunner = {
      run(input) {
        const raw = readFileSync(input.env.MANTA_SNAPSHOT_PATH!, 'utf-8');
        captured.push(JSON.parse(raw) as Snapshot);
        return realRunner.run(input);
      },
    };
    await runCastCommand(rt, {
      mode: 'recon-swarm',
      task: 'map src/',
      cloneCount: 2,
      cycleIntervalMs: 50,
      tickBudgetMs: 15_000,
      castId: 'cast-batch-sid-1',
      budgetUsdPerClone: 5,
      budgetUsdPerCast: 15,
      runner: recordingRunner,
      reporter: createReporter({ sink: new MemorySink() }),
      verifyMcp: false,
    });
    for (const snap of captured) {
      expect(snap.sessionMode).toBe('batch');
      expect(snap.sessionId).toBeUndefined();
    }
  });
});

// Bug #31 regression — `validateDisjointPartitions` ran AFTER
// `runPreSpawnGate`, which had already debited the charge and recorded the
// daily spend. An operator-typo overlapping partition surfaced as a thrown
// CliError, but the unwind path didn't refund — so the cast budget leaked
// on a pure validation failure. Fix: move the partition check above the
// gate so every operator-typo guard runs before any state-committing call.
describe('cast command — refactor-wave operator-typo guards run before state commit (bug #31)', () => {
  let fx: RepoFixture | undefined;
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  it('overlapping partitions throw without debiting charges or daily spend', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });

    const chargesBefore = await rt.ctx.charges.read();
    const spendBefore = await rt.ctx.dailySpend.read();

    await expect(
      runCastCommand(rt, {
        mode: 'refactor-wave' as unknown as 'recon-swarm',
        task: 'migrate errors',
        cloneCount: 2,
        cycleIntervalMs: 50,
        tickBudgetMs: 5_000,
        castId: 'cast-rw-bug31',
        budgetUsdPerClone: 5,
        budgetUsdPerCast: 15,
        cloneAssignments: {
          A: {
            task: 'migrate src/auth',
            scope: { allowed_paths: ['src/auth'], forbidden_paths: ['.manta/state', 'secrets/'], max_files_changed: 10 },
          },
          // Same allowed_paths as A — operator-typo overlap.
          B: {
            task: 'migrate src/auth',
            scope: { allowed_paths: ['src/auth'], forbidden_paths: ['.manta/state', 'secrets/'], max_files_changed: 10 },
          },
        },
        runner: runFakeCloneScript({ scriptPath: fixturePath }),
        reporter: createReporter({ sink: new MemorySink() }),
        verifyMcp: false,
      }),
    ).rejects.toMatchObject({
      name: 'CliError',
      kind: 'invalid_input',
      message: expect.stringContaining('Overlapping partition') as unknown as string,
    });

    const chargesAfter = await rt.ctx.charges.read();
    const spendAfter = await rt.ctx.dailySpend.read();

    expect(chargesAfter.current_charges).toBe(chargesBefore.current_charges);
    expect(spendAfter.spent_usd).toBe(spendBefore.spent_usd);
  });

  it('nested partitions throw without debiting charges or daily spend', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });

    const chargesBefore = await rt.ctx.charges.read();
    const spendBefore = await rt.ctx.dailySpend.read();

    await expect(
      runCastCommand(rt, {
        mode: 'refactor-wave' as unknown as 'recon-swarm',
        task: 'migrate errors',
        cloneCount: 2,
        cycleIntervalMs: 50,
        tickBudgetMs: 5_000,
        castId: 'cast-rw-bug31-nested',
        budgetUsdPerClone: 5,
        budgetUsdPerCast: 15,
        cloneAssignments: {
          A: {
            task: 'migrate src/auth',
            scope: { allowed_paths: ['src/auth/'], forbidden_paths: ['.manta/state'], max_files_changed: 10 },
          },
          B: {
            task: 'migrate src/auth/login',
            scope: { allowed_paths: ['src/auth/login/'], forbidden_paths: ['.manta/state'], max_files_changed: 10 },
          },
        },
        runner: runFakeCloneScript({ scriptPath: fixturePath }),
        reporter: createReporter({ sink: new MemorySink() }),
        verifyMcp: false,
      }),
    ).rejects.toMatchObject({
      name: 'CliError',
      kind: 'invalid_input',
      message: expect.stringContaining('Nested partition overlap') as unknown as string,
    });

    const chargesAfter = await rt.ctx.charges.read();
    const spendAfter = await rt.ctx.dailySpend.read();

    expect(chargesAfter.current_charges).toBe(chargesBefore.current_charges);
    expect(spendAfter.spent_usd).toBe(spendBefore.spent_usd);
  });
});

// B8 regression — the MCP pre-flight (verifyMantaBusRegistered) ran AFTER
// runPreSpawnGate, which had already debited the charge and recorded the daily
// spend (`gate.committed`). A user whose bus is not registered (e.g. a plugin
// user hit by B1) therefore drained charges to zero just retrying a cast that
// could never spawn — the preflight threw, but the charge was already gone with
// no refund. Fix: run the preflight BEFORE the charge-committing gate (same
// "guards before state commit" philosophy as bug #31), so a preflight abort
// debits nothing.
describe('cast command — preflight failure does not burn charges (B8)', () => {
  let fx: RepoFixture | undefined;
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  it('a cast whose MCP preflight throws does NOT decrement charges or record spend', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });

    const chargesBefore = await rt.ctx.charges.read();
    const spendBefore = await rt.ctx.dailySpend.read();

    const sink = new MemorySink();
    // verifyMcp defaults to ON; inject a throwing preflight to drive the
    // bus-not-registered abort deterministically, without a real `claude`
    // binary on PATH. This is the exact shape verifyMantaBusRegistered throws.
    await expect(
      runCastCommand(rt, {
        mode: 'recon-swarm',
        task: 't',
        cloneCount: 1,
        cycleIntervalMs: 50,
        runner: runFakeCloneScript({ scriptPath: fixturePath }),
        reporter: createReporter({ sink }),
        tickBudgetMs: 5_000,
        castId: 'cast-b8',
        budgetUsdPerClone: 5,
        budgetUsdPerCast: 15,
        preflight: () =>
          Promise.reject(new CliError('manta-bus not registered', { kind: 'spawn_failed' })),
      }),
    ).rejects.toMatchObject({ name: 'CliError', kind: 'spawn_failed' });

    const chargesAfter = await rt.ctx.charges.read();
    const spendAfter = await rt.ctx.dailySpend.read();

    // The charge was NOT debited and no daily spend was recorded: the preflight
    // aborted before runPreSpawnGate's commit step ever ran.
    expect(chargesAfter.current_charges).toBe(chargesBefore.current_charges);
    expect(spendAfter.spent_usd).toBe(spendBefore.spent_usd);
    // And `gate.committed` (the event emitted at the commit point) never fired.
    const events = sink.lines.map((l) => l.event);
    expect(events).not.toContain('gate.committed');
  });

  it('preflight runs before the gate: a dry-run still skips it (no bus needed for a cost preview)', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });

    let preflightCalls = 0;
    const result = await runCastCommand(rt, {
      mode: 'recon-swarm',
      task: 't',
      cloneCount: 1,
      cycleIntervalMs: 50,
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      reporter: createReporter({ sink: new MemorySink() }),
      tickBudgetMs: 5_000,
      castId: 'cast-b8-dry',
      budgetUsdPerClone: 5,
      budgetUsdPerCast: 15,
      dryRun: true,
      preflight: () => {
        preflightCalls += 1;
        return Promise.reject(new CliError('should not run on dry-run', { kind: 'spawn_failed' }));
      },
    });
    // Dry-run returns cleanly WITHOUT invoking the preflight — a cost preview
    // must not require a live bus (and must not be blocked by a throwing one).
    expect(result.exitCode).toBe(0);
    expect(preflightCalls).toBe(0);
  });
});

describe('validateDisjointPartitions', () => {
  it('accepts non-overlapping partitions', () => {
    expect(() =>
      validateDisjointPartitions({
        A: {
          task: 'a',
          scope: { allowed_paths: ['src/auth'], forbidden_paths: [], max_files_changed: 5 },
        },
        B: {
          task: 'b',
          scope: { allowed_paths: ['src/billing'], forbidden_paths: [], max_files_changed: 5 },
        },
      }),
    ).not.toThrow();
  });

  it('skips validation when assignment has no scope', () => {
    expect(() =>
      validateDisjointPartitions({
        A: { task: 'a' },
        B: { task: 'b' },
      }),
    ).not.toThrow();
  });
});

// Bug #21 regression — daemon clones in WAITING_FOR_TASK state must be
// recognised as idle by cast.ts allDone. Without this set, a daemon clone
// calling manta.request_task (per the priming preamble) hangs the cast
// until budget abort because allDone never returns true.
describe('DAEMON_IDLE_STATES', () => {
  it('includes IDLE and WAITING_FOR_TASK', () => {
    expect(DAEMON_IDLE_STATES.has('IDLE')).toBe(true);
    expect(DAEMON_IDLE_STATES.has('WAITING_FOR_TASK')).toBe(true);
  });

  it('excludes non-idle states', () => {
    expect(DAEMON_IDLE_STATES.has('WORKING')).toBe(false);
    expect(DAEMON_IDLE_STATES.has('STARTING')).toBe(false);
    expect(DAEMON_IDLE_STATES.has('BLOCKED')).toBe(false);
    expect(DAEMON_IDLE_STATES.has('WINDING_DOWN')).toBe(false);
    expect(DAEMON_IDLE_STATES.has('DEAD')).toBe(false);
  });
});

// Phase 7a Chunk 2 task 2.4 — hash-pin verification on every cast.
// The integration sits between compat (exit 16) and the mode-lookup (exit 1),
// so a lockfile entry whose on-disk content drifted must fail with exit 19
// before the mode validation ever runs.
describe('cast command — hash-pin verification (task 2.4)', () => {
  let fx: RepoFixture | undefined;
  let fakeHome: string | undefined;
  let restoreHome: string | undefined;

  afterEach(async () => {
    if (restoreHome !== undefined) {
      process.env.HOME = restoreHome;
      restoreHome = undefined;
    }
    if (fakeHome) {
      await fs.rm(fakeHome, { recursive: true, force: true });
      fakeHome = undefined;
    }
    await fx?.cleanup();
    fx = undefined;
  });

  it('refuses to cast with exit 19 when an installed library package is tampered on disk', async () => {
    const { createLocalStore } = await import('../../src/library/local-store.js');
    const { createLockfileStore } = await import('../../src/library/lockfile.js');
    const { computeDirDigest } = await import('../../src/library/dir-digest.js');
    const { MANTA_CLI_VERSION } = await import('../../src/library/cli-version.js');

    fx = await makeRepoFixture();
    fakeHome = await fs.mkdtemp(join(tmpdir(), 'manta-cast-tamper-'));
    restoreHome = process.env.HOME;
    process.env.HOME = fakeHome;

    const localStore = createLocalStore({ homeDir: fakeHome });
    const installDir = localStore.pathFor('@manta-library/tamper-victim', '0.1.0');
    await fs.mkdir(installDir, { recursive: true });
    await fs.writeFile(
      join(installDir, 'manta-package.json'),
      JSON.stringify({ schemaVersion: 1, name: '@manta-library/tamper-victim', version: '0.1.0' }),
      'utf8',
    );
    await fs.writeFile(join(installDir, 'README.md'), '# original\n', 'utf8');
    const recordedDigest = await computeDirDigest(installDir);

    const lockfile = createLockfileStore({ repoRoot: fx.root });
    await lockfile.write({
      schemaVersion: 1,
      mantaVersion: MANTA_CLI_VERSION,
      generatedAt: '2026-05-28T11:30:00.000Z',
      packages: {
        '@manta-library/tamper-victim': {
          version: '0.1.0',
          resolved: 'file://fixture',
          integrity: 'sha256-AAAaaa==',
          directoryDigest: recordedDigest,
          contributes: { modes: [], skills: [], commands: [], templates: [] },
          mantaVersionCompat: '>=0.0.0',
          installedAt: '2026-05-28T11:30:00.000Z',
        },
      },
    });

    // Now mutate one byte on disk — simulates a manual edit, a corrupted
    // install, or an attacker's tampering after the lock was committed.
    await fs.writeFile(join(installDir, 'README.md'), '# tampered\n', 'utf8');

    const rt = await createRuntime({ repoRoot: fx.root, homeDir: fakeHome });
    let caught: { message: string; exitCode?: number } | undefined;
    try {
      await runCastCommand(rt, {
        mode: 'recon-swarm',
        task: 't',
        cloneCount: 1,
        cycleIntervalMs: 50,
        runner: runFakeCloneScript({ scriptPath: fixturePath }),
        reporter: noopReporter,
        tickBudgetMs: 1_000,
        castId: 'cast-tampered',
        budgetUsdPerClone: 5,
        budgetUsdPerCast: 15,
        verifyMcp: false,
      });
    } catch (err) {
      caught = err as { message: string; exitCode?: number };
    }
    expect(caught).toBeDefined();
    expect(caught!.exitCode).toBe(19);
    expect(caught!.message).toContain('@manta-library/tamper-victim');
    expect(caught!.message).toContain('0.1.0');
    expect(caught!.message).toContain(recordedDigest);
    expect(caught!.message).toContain('manta install');
    expect(caught!.message).toContain('--force');
  });

  it('refuses to cast with exit 19 when the install directory is missing entirely', async () => {
    const { createLockfileStore } = await import('../../src/library/lockfile.js');
    const { MANTA_CLI_VERSION } = await import('../../src/library/cli-version.js');

    fx = await makeRepoFixture();
    fakeHome = await fs.mkdtemp(join(tmpdir(), 'manta-cast-missing-'));
    restoreHome = process.env.HOME;
    process.env.HOME = fakeHome;

    // Lockfile claims an install that never landed on disk — handles the
    // checked-in-lockfile-but-no-install case (e.g. fresh CI checkout that
    // skipped `manta install`, or `rm -rf ~/.manta/library/`).
    const lockfile = createLockfileStore({ repoRoot: fx.root });
    await lockfile.write({
      schemaVersion: 1,
      mantaVersion: MANTA_CLI_VERSION,
      generatedAt: '2026-05-28T11:30:00.000Z',
      packages: {
        '@manta-library/ghost': {
          version: '0.1.0',
          resolved: 'file://fixture',
          integrity: 'sha256-AAAaaa==',
          directoryDigest: 'sha256-EXPECTEDxxx==',
          contributes: { modes: [], skills: [], commands: [], templates: [] },
          mantaVersionCompat: '>=0.0.0',
          installedAt: '2026-05-28T11:30:00.000Z',
        },
      },
    });

    const rt = await createRuntime({ repoRoot: fx.root, homeDir: fakeHome });
    let caught: { message: string; exitCode?: number } | undefined;
    try {
      await runCastCommand(rt, {
        mode: 'recon-swarm',
        task: 't',
        cloneCount: 1,
        cycleIntervalMs: 50,
        runner: runFakeCloneScript({ scriptPath: fixturePath }),
        reporter: noopReporter,
        tickBudgetMs: 1_000,
        castId: 'cast-ghost',
        budgetUsdPerClone: 5,
        budgetUsdPerCast: 15,
        verifyMcp: false,
      });
    } catch (err) {
      caught = err as { message: string; exitCode?: number };
    }
    expect(caught).toBeDefined();
    expect(caught!.exitCode).toBe(19);
    expect(caught!.message).toContain('@manta-library/ghost');
    expect(caught!.message).toContain('install directory is missing');
  });
});
