import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkQueueStore, busPaths, systemClock } from '@manta/bus';
import { runFakeCloneScript, spawnClone } from '../../src/spawner/clone-spawner.js';
import { runDaemonLoop } from '../../src/daemon-loop.js';
import { createRuntime, type Runtime } from '../../src/runtime.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';
import { makeSnapshotFor } from '../helpers/snapshotFixture.js';

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'fake-clone.mjs',
);

describe('daemon lifecycle integration', () => {
  let fx: RepoFixture | undefined;
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  it('spawns daemon clones, processes work queue items, and exits on no_work', async () => {
    fx = await makeRepoFixture('manta-daemon-int-');
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: {
        heartbeatTimeoutMs: 200,
        startupGraceMs: 200,
        parentPidCheckEnabled: false,
      },
    });

    const castId = 'cast-daemon-1';
    const cloneId = 'A';

    // Spawn the initial clone (fake script exits immediately — simulates batch initial task)
    const handle = await spawnClone({
      repoRoot: fx.root,
      snapshot: makeSnapshotFor({
        cloneId,
        castId,
        mode: 'pair-programming',
        task: 'initial daemon task',
      }),
      worktree: fx.root,
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      registry: rt.ctx.registry,
      casts: rt.ctx.casts,
      castMode: 'pair-programming',
      castPolicy: { peer_messaging: 'allowed', auto_merge_threshold: null, session_mode: 'daemon' as const },
      castRoster: [{ clone_id: 'A', assignment: null }, { clone_id: 'B', assignment: null }],
    });

    // Wait for initial task to complete
    await handle.exit;

    // Create work queue and enqueue items
    const paths = busPaths(fx.root);
    const wq = new WorkQueueStore(paths, systemClock);

    await wq.enqueue({
      cast_id: castId,
      target_clone_id: cloneId,
      prompt: 'daemon work item 1',
      priority: 'normal',
    });
    await wq.enqueue({
      cast_id: castId,
      target_clone_id: cloneId,
      prompt: 'daemon work item 2',
      priority: 'high',
    });

    // Verify work queue has 2 pending items
    const pendingBefore = await wq.pending(cloneId);
    expect(pendingBefore).toHaveLength(2);
    // High priority should be dequeued first
    const firstItem = await wq.dequeue(cloneId);
    expect(firstItem).not.toBeNull();
    expect(firstItem!.priority).toBe('high');
    expect(firstItem!.prompt).toBe('daemon work item 2');

    // Complete and verify
    await wq.complete(firstItem!.id);
    const pendingAfter = await wq.pending(cloneId);
    expect(pendingAfter).toHaveLength(1);
  });

  it('daemon-loop runs resume cycle and exits on max_failures with bad binary', async () => {
    fx = await makeRepoFixture('manta-daemon-loop-');
    const paths = busPaths(fx.root);
    const wq = new WorkQueueStore(paths, systemClock);

    await wq.enqueue({
      cast_id: 'cast-d2',
      target_clone_id: 'A',
      prompt: 'will fail to resume',
      priority: 'normal',
    });
    await wq.enqueue({
      cast_id: 'cast-d2',
      target_clone_id: 'A',
      prompt: 'also fails',
      priority: 'normal',
    });

    const result = await runDaemonLoop({
      sessionId: 'sess-test-e2e',
      cloneId: 'A',
      castId: 'cast-d2',
      worktree: fx.root,
      workQueue: wq,
      appendSystemPrompt: 'test',
      env: {},
      pollIntervalMs: 10,
      maxResumeFailures: 2,
      maxEmptyPolls: 1,
      claudeBin: '/no/such/binary/manta-daemon-e2e',
    });

    expect(result.exitReason).toBe('max_failures');
    expect(result.resumeCycles).toBe(0);
    expect(result.itemsCompleted).toHaveLength(0);
  });

  it('daemon-loop exits with no_work when queue is empty', async () => {
    fx = await makeRepoFixture('manta-daemon-empty-');
    const paths = busPaths(fx.root);
    const wq = new WorkQueueStore(paths, systemClock);

    const result = await runDaemonLoop({
      sessionId: 'sess-empty',
      cloneId: 'B',
      castId: 'cast-d3',
      worktree: fx.root,
      workQueue: wq,
      appendSystemPrompt: 'test',
      env: {},
      pollIntervalMs: 5,
      maxResumeFailures: 3,
      maxEmptyPolls: 2,
      claudeBin: '/usr/bin/true',
    });

    expect(result.exitReason).toBe('no_work');
    expect(result.resumeCycles).toBe(0);
  });

  it('daemon-loop respects abort signal', async () => {
    fx = await makeRepoFixture('manta-daemon-abort-');
    const paths = busPaths(fx.root);
    const wq = new WorkQueueStore(paths, systemClock);

    const ac = new AbortController();
    ac.abort();

    const result = await runDaemonLoop({
      sessionId: 'sess-abort',
      cloneId: 'A',
      castId: 'cast-d4',
      worktree: fx.root,
      workQueue: wq,
      appendSystemPrompt: 'test',
      env: {},
      pollIntervalMs: 5,
      maxResumeFailures: 3,
      maxEmptyPolls: 10,
      signal: ac.signal,
      claudeBin: '/usr/bin/true',
    });

    expect(result.exitReason).toBe('aborted');
  });

  it('daemon-loop processes items with /usr/bin/true and completes them', async () => {
    fx = await makeRepoFixture('manta-daemon-success-');
    const paths = busPaths(fx.root);
    const wq = new WorkQueueStore(paths, systemClock);

    await wq.enqueue({
      cast_id: 'cast-d5',
      target_clone_id: 'A',
      prompt: 'test item 1',
      priority: 'normal',
    });

    const completedIds: string[] = [];
    const result = await runDaemonLoop({
      sessionId: 'sess-success',
      cloneId: 'A',
      castId: 'cast-d5',
      worktree: fx.root,
      workQueue: wq,
      appendSystemPrompt: 'test',
      env: {},
      pollIntervalMs: 5,
      maxResumeFailures: 3,
      maxEmptyPolls: 1,
      claudeBin: '/usr/bin/true',
      onCycleComplete: async (item) => {
        completedIds.push(item.id);
      },
    });

    expect(result.exitReason).toBe('no_work');
    expect(result.resumeCycles).toBe(1);
    expect(result.itemsCompleted).toHaveLength(1);
    expect(completedIds).toHaveLength(1);
  });
});
