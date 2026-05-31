import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Snapshot } from '@manta/snapshot';
import { runCastCommand } from '../../src/commands/cast.js';
import {
  runFakeCloneScript,
  type CloneRunner,
} from '../../src/spawner/clone-spawner.js';
import { createReporter, MemorySink } from '../../src/output/reporter.js';
import { createRuntime } from '../../src/runtime.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';
import { TestStormDispatcher } from '../../src/dispatch/test-storm-dispatch.js';

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'fake-clone.mjs',
);

describe('test-storm dispatch integration', () => {
  let fx: RepoFixture | undefined;
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  it('test-storm cast assigns coder/tester/fuzzer roles to 3 clones', async () => {
    fx = await makeRepoFixture('manta-storm-int-');
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
    const sink = new MemorySink();
    const result = await runCastCommand(rt, {
      mode: 'test-storm' as unknown as 'recon-swarm',
      task: 'implement and test caching layer',
      cloneCount: 3,
      cycleIntervalMs: 50,
      tickBudgetMs: 15_000,
      castId: 'cast-storm-int-1',
      internalTokenEstimatePerClone: 5,
      internalTokenEstimatePerCast: 20,
      runner: recordingRunner,
      reporter: createReporter({ sink }),
      verifyMcp: false,
    });
    expect(result.exitCode).toBe(0);

    const events = sink.lines.map((l) => l.event);
    expect(events).toContain('cast.spawn');
    expect(events).toContain('cast.done');

    expect(captured).toHaveLength(3);
    const hints = captured.map((s) => s.taskContract.approachHint).sort();
    expect(hints).toEqual(['coder', 'fuzzer', 'tester']);
  });

  it('test-storm with 2 clones assigns coder/tester (fuzzer defaults to tester)', async () => {
    fx = await makeRepoFixture('manta-storm-2c-');
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
    const result = await runCastCommand(rt, {
      mode: 'test-storm' as unknown as 'recon-swarm',
      task: 'test cache module',
      cloneCount: 2,
      cycleIntervalMs: 50,
      tickBudgetMs: 15_000,
      castId: 'cast-storm-2c-1',
      internalTokenEstimatePerClone: 5,
      internalTokenEstimatePerCast: 15,
      runner: recordingRunner,
      reporter: createReporter({ sink: new MemorySink() }),
      verifyMcp: false,
    });
    expect(result.exitCode).toBe(0);
    expect(captured).toHaveLength(2);
    expect(captured[0]!.taskContract.approachHint).toBe('coder');
    expect(captured[1]!.taskContract.approachHint).toBe('tester');
  });

  it('test-storm sets session_mode=daemon and peer_messaging=allowed', async () => {
    fx = await makeRepoFixture('manta-storm-policy-');
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: {
        heartbeatTimeoutMs: 100,
        startupGraceMs: 100,
        parentPidCheckEnabled: false,
      },
    });
    await runCastCommand(rt, {
      mode: 'test-storm' as unknown as 'recon-swarm',
      task: 'test cache',
      cloneCount: 2,
      cycleIntervalMs: 50,
      tickBudgetMs: 15_000,
      castId: 'cast-storm-policy-int',
      internalTokenEstimatePerClone: 5,
      internalTokenEstimatePerCast: 15,
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      reporter: createReporter({ sink: new MemorySink() }),
      verifyMcp: false,
    });
    const manifestPath = path.join(fx.root, '.manta', 'state', 'casts', 'cast-storm-policy-int.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      mode: string;
      policy: { session_mode: string; peer_messaging: string };
    };
    expect(manifest.policy.session_mode).toBe('daemon');
    expect(manifest.policy.peer_messaging).toBe('allowed');
  });

  it('test-storm rejects 1 or 4+ clones', async () => {
    fx = await makeRepoFixture('manta-storm-reject-');
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: {
        heartbeatTimeoutMs: 100,
        startupGraceMs: 100,
        parentPidCheckEnabled: false,
      },
    });
    const runner = runFakeCloneScript({ scriptPath: fixturePath });
    const reporter = createReporter({ sink: new MemorySink() });

    await expect(runCastCommand(rt, {
      mode: 'test-storm' as unknown as 'recon-swarm',
      task: 'test',
      cloneCount: 1,
      cycleIntervalMs: 50,
      tickBudgetMs: 5_000,
      castId: 'cast-storm-1c',
      internalTokenEstimatePerClone: 5,
      internalTokenEstimatePerCast: 10,
      runner,
      reporter,
      verifyMcp: false,
    })).rejects.toThrow(/2-3 clones/);

    await expect(runCastCommand(rt, {
      mode: 'test-storm' as unknown as 'recon-swarm',
      task: 'test',
      cloneCount: 4,
      cycleIntervalMs: 50,
      tickBudgetMs: 5_000,
      castId: 'cast-storm-4c',
      internalTokenEstimatePerClone: 5,
      internalTokenEstimatePerCast: 25,
      runner,
      reporter,
      verifyMcp: false,
    })).rejects.toThrow(/2-3 clones/);
  });
});

describe('TestStormDispatcher pipeline integration', () => {
  const config = {
    coderCloneId: 'A',
    testerCloneId: 'B',
    fuzzerCloneId: 'C',
    castId: 'cast-1',
    maxFixCycles: 3,
  };

  it('happy path: code_ready → tests_ready (pass) → fuzz_complete → done', async () => {
    const d = new TestStormDispatcher(config);
    const enqueued: Array<{ target: string; prompt: string }> = [];
    const enqueuer = { enqueue: async (target: string, prompt: string) => { enqueued.push({ target, prompt }); } };

    await d.onCycleComplete({
      idleClones: [{ clone_id: 'A', idle_since: 100 }],
      broadcasts: [{
        clone_id: 'A', event_type: 'code_ready',
        payload: { feature_id: 'feat-1', commit_ref: 'a1', summary: 'cache impl', files_changed: ['src/cache.ts'] },
      }],
    }, enqueuer);
    expect(d.stages.get('feat-1')!.status).toBe('testing');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.target).toBe('B');

    enqueued.length = 0;
    await d.onCycleComplete({
      idleClones: [{ clone_id: 'B', idle_since: 200 }],
      broadcasts: [{
        clone_id: 'B', event_type: 'tests_ready',
        payload: { feature_id: 'feat-1', verdict: 'pass', commit_ref: 'b1', summary: '8 tests pass' },
      }],
    }, enqueuer);
    expect(d.stages.get('feat-1')!.status).toBe('fuzzing');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.target).toBe('C');

    enqueued.length = 0;
    await d.onCycleComplete({
      idleClones: [{ clone_id: 'C', idle_since: 300 }],
      broadcasts: [{
        clone_id: 'C', event_type: 'fuzz_complete',
        payload: { feature_id: 'feat-1', commit_ref: 'c1', summary: '3 property tests' },
      }],
    }, enqueuer);
    expect(d.stages.get('feat-1')!.status).toBe('complete');
    expect(d.isDone).toBe(true);
    expect(enqueued).toHaveLength(0);
  });

  it('fix cycle: tester fails → coder fixes → tester re-tests → pass', async () => {
    const d = new TestStormDispatcher(config);
    const enqueued: Array<{ target: string; priority?: string }> = [];
    const enqueuer = { enqueue: async (target: string, _prompt: string, priority?: string) => { enqueued.push({ target, ...(priority !== undefined ? { priority } : {}) }); } };

    await d.onCycleComplete({
      idleClones: [],
      broadcasts: [{
        clone_id: 'A', event_type: 'code_ready',
        payload: { feature_id: 'feat-1', commit_ref: 'a1', summary: 'impl' },
      }],
    }, enqueuer);
    expect(d.stages.get('feat-1')!.status).toBe('testing');

    enqueued.length = 0;
    await d.onCycleComplete({
      idleClones: [],
      broadcasts: [{
        clone_id: 'B', event_type: 'tests_ready',
        payload: {
          feature_id: 'feat-1', verdict: 'fail',
          failures: [{ test: 'cache.test.ts', error: 'null ref' }],
        },
      }],
    }, enqueuer);
    expect(d.stages.get('feat-1')!.status).toBe('fixing');
    expect(d.stages.get('feat-1')!.fixCycles).toBe(1);
    expect(enqueued[0]!.target).toBe('A');
    expect(enqueued[0]!.priority).toBe('high');

    enqueued.length = 0;
    await d.onCycleComplete({
      idleClones: [],
      broadcasts: [{
        clone_id: 'A', event_type: 'code_ready',
        payload: { feature_id: 'feat-1', commit_ref: 'a2', summary: 'fix null ref' },
      }],
    }, enqueuer);
    expect(d.stages.get('feat-1')!.status).toBe('testing');

    enqueued.length = 0;
    await d.onCycleComplete({
      idleClones: [],
      broadcasts: [{
        clone_id: 'B', event_type: 'tests_ready',
        payload: { feature_id: 'feat-1', verdict: 'pass', commit_ref: 'b2', summary: 'all pass' },
      }],
    }, enqueuer);
    expect(d.stages.get('feat-1')!.status).toBe('fuzzing');
    expect(d.stages.get('feat-1')!.fixCycles).toBe(1);
  });

  it('escalation: 3 fix cycles exceeded → stage escalated', async () => {
    const d = new TestStormDispatcher(config);
    const enqueued: Array<{ target: string }> = [];
    const enqueuer = { enqueue: async (target: string) => { enqueued.push({ target }); } };

    await d.onCycleComplete({
      idleClones: [],
      broadcasts: [{
        clone_id: 'A', event_type: 'code_ready',
        payload: { feature_id: 'feat-1', commit_ref: 'a1', summary: 'impl' },
      }],
    }, enqueuer);

    for (let cycle = 0; cycle < 3; cycle++) {
      enqueued.length = 0;
      await d.onCycleComplete({
        idleClones: [],
        broadcasts: [{
          clone_id: 'B', event_type: 'tests_ready',
          payload: { feature_id: 'feat-1', verdict: 'fail', failures: [{ test: 'x', error: 'err' }] },
        }],
      }, enqueuer);
      if (d.stages.get('feat-1')!.status === 'fixing') {
        enqueued.length = 0;
        await d.onCycleComplete({
          idleClones: [],
          broadcasts: [{
            clone_id: 'A', event_type: 'code_ready',
            payload: { feature_id: 'feat-1', commit_ref: `fix-${cycle}`, summary: 'fix attempt' },
          }],
        }, enqueuer);
      }
    }

    enqueued.length = 0;
    await d.onCycleComplete({
      idleClones: [],
      broadcasts: [{
        clone_id: 'B', event_type: 'tests_ready',
        payload: { feature_id: 'feat-1', verdict: 'fail', failures: [{ test: 'x', error: 'still fails' }] },
      }],
    }, enqueuer);
    expect(d.stages.get('feat-1')!.status).toBe('escalated');
    expect(d.stages.get('feat-1')!.fixCycles).toBe(3);
    expect(enqueued).toHaveLength(0);
    expect(d.isDone).toBe(true);
  });
});
