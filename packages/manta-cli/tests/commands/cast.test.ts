import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runCastCommand } from '../../src/commands/cast.js';
import { runFakeCloneScript } from '../../src/spawner/clone-spawner.js';
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
      message: expect.stringContaining('cumulative budget'),
    });
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
