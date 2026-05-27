import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { runDaemonLoop, type DaemonLoopOptions } from '../src/daemon-loop.js';
import type { CloneRunner } from '../src/spawner/clone-spawner.js';
import type { WorkItem, WorkQueueStore } from '@manta/bus';

function makeWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: overrides.id ?? `wq-${Date.now()}-abc`,
    cast_id: overrides.cast_id ?? 'cast-1',
    target_clone_id: overrides.target_clone_id ?? 'A',
    prompt: overrides.prompt ?? 'do something',
    priority: overrides.priority ?? 'normal',
    enqueued_at: overrides.enqueued_at ?? Date.now(),
    ...overrides,
  };
}

function makeFakeWorkQueue(items: WorkItem[] = []): WorkQueueStore {
  const queue = [...items];
  return {
    async dequeue(targetCloneId: string): Promise<WorkItem | null> {
      const idx = queue.findIndex(
        (i) => i.target_clone_id === targetCloneId && !i.claimed_at,
      );
      if (idx === -1) return null;
      queue[idx]!.claimed_at = Date.now();
      return { ...queue[idx]! };
    },
    async complete(itemId: string): Promise<void> {
      const item = queue.find((i) => i.id === itemId);
      if (item) item.completed_at = Date.now();
    },
    async enqueue() {
      throw new Error('not used in test');
    },
    async pending() {
      return queue.filter((i) => !i.claimed_at);
    },
  } as unknown as WorkQueueStore;
}

const successRunner: CloneRunner = {
  run() {
    return execa(process.execPath, ['-e', 'process.exit(0)'], { reject: false });
  },
};

const failRunner: CloneRunner = {
  run() {
    return execa('/no/such/binary/manta-test-daemon-fail', [], { reject: false });
  },
};

function makeOpts(overrides: Partial<DaemonLoopOptions> = {}): DaemonLoopOptions {
  return {
    sessionId: 'sess-test',
    cloneId: 'A',
    castId: 'cast-1',
    worktree: '/tmp',
    workQueue: makeFakeWorkQueue(),
    appendSystemPrompt: 'test',
    env: {},
    pollIntervalMs: 1,
    maxResumeFailures: 3,
    maxEmptyPolls: 2,
    runner: successRunner,
    ...overrides,
  };
}

describe('runDaemonLoop', () => {
  it('exits with no_work after maxEmptyPolls', async () => {
    const result = await runDaemonLoop(makeOpts({ maxEmptyPolls: 2 }));
    expect(result.exitReason).toBe('no_work');
    expect(result.resumeCycles).toBe(0);
    expect(result.itemsCompleted).toHaveLength(0);
  });

  it('processes work item and marks it complete', async () => {
    const item = makeWorkItem({ id: 'wq-1', target_clone_id: 'A' });
    const wq = makeFakeWorkQueue([item]);
    const result = await runDaemonLoop(
      makeOpts({ workQueue: wq, maxEmptyPolls: 1 }),
    );
    expect(result.resumeCycles).toBe(1);
    expect(result.itemsCompleted).toEqual(['wq-1']);
    expect(result.exitReason).toBe('no_work');
  });

  it('exits with aborted when signal fires', async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await runDaemonLoop(
      makeOpts({ signal: ac.signal }),
    );
    expect(result.exitReason).toBe('aborted');
    expect(result.resumeCycles).toBe(0);
  });

  it('calls onCycleComplete after each successful item', async () => {
    const item = makeWorkItem({ id: 'wq-2', target_clone_id: 'A' });
    const completedItems: string[] = [];
    const result = await runDaemonLoop(
      makeOpts({
        workQueue: makeFakeWorkQueue([item]),
        maxEmptyPolls: 1,
        onCycleComplete: async (wi) => {
          completedItems.push(wi.id);
        },
      }),
    );
    expect(completedItems).toEqual(['wq-2']);
    expect(result.resumeCycles).toBe(1);
  });

  it('exits with max_failures after consecutive resume failures', async () => {
    const items = [
      makeWorkItem({ id: 'wq-f1', target_clone_id: 'A' }),
      makeWorkItem({ id: 'wq-f2', target_clone_id: 'A' }),
      makeWorkItem({ id: 'wq-f3', target_clone_id: 'A' }),
    ];
    const result = await runDaemonLoop(
      makeOpts({
        workQueue: makeFakeWorkQueue(items),
        maxResumeFailures: 3,
        runner: failRunner,
      }),
    );
    expect(result.exitReason).toBe('max_failures');
    expect(result.resumeCycles).toBe(0);
  });

  it('resets empty poll counter when item is found', async () => {
    let dequeueCount = 0;
    const item = makeWorkItem({ id: 'wq-reset', target_clone_id: 'A' });
    const wq: WorkQueueStore = {
      async dequeue() {
        dequeueCount++;
        if (dequeueCount === 2) {
          return { ...item, claimed_at: Date.now() };
        }
        return null;
      },
      async complete() {},
      async enqueue() { throw new Error('unused'); },
      async pending() { return []; },
    } as unknown as WorkQueueStore;
    const result = await runDaemonLoop(
      makeOpts({ workQueue: wq, maxEmptyPolls: 3 }),
    );
    expect(result.resumeCycles).toBe(1);
    expect(result.exitReason).toBe('no_work');
  });
});
