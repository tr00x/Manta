import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runCastCommand } from '../../src/commands/cast.js';
import {
  runFakeCloneScript,
  type CloneRunner,
} from '../../src/spawner/clone-spawner.js';
import { createReporter, MemorySink } from '../../src/output/reporter.js';
import { createRuntime } from '../../src/runtime.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';

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
      thresholdOverrides: { heartbeatTimeoutMs: 100, parentPidCheckEnabled: false },
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
    // Each clone has a worktree.
    for (const id of ['A', 'B']) {
      const wt = path.join(fx.root, '.manta', 'worktrees', `clone-${id}`);
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
    // Reporter captured key events.
    const events = sink.lines.map((l) => l.event);
    expect(events).toContain('cast.spawn');
    expect(events).toContain('cast.done');
  });

  it('rejects unsupported modes', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    await expect(
      runCastCommand(rt, {
        // Cast through `unknown` to keep the type-system honest while still
        // exercising the runtime's invalid_input branch for non-recon-swarm.
        mode: 'forking-realities' as unknown as 'recon-swarm',
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
  // `clone-${id}` paths and `manta/${castId}/${id}` branch names.
  it('cleans up partial worktrees when a clone fails to spawn mid-cast', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: { heartbeatTimeoutMs: 100, parentPidCheckEnabled: false },
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
    const wtA = path.join(fx.root, '.manta', 'worktrees', 'clone-A');
    const aExists = await fs
      .access(wtA)
      .then(() => true)
      .catch(() => false);
    expect(aExists).toBe(false);
    // 2nd clone never had its worktree created (runner.run threw before
    // spawnClone returned a handle, but addWorktree had already run for B
    // before runner.run was called) — verify it is also gone.
    const wtB = path.join(fx.root, '.manta', 'worktrees', 'clone-B');
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

  it('writes the task contract (translated to bus snake_case schema) before spawning', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: { heartbeatTimeoutMs: 100, parentPidCheckEnabled: false },
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
});
