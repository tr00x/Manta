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

function makeFakeWorkQueue(items: WorkItem[] = []): WorkQueueStore & { released: string[] } {
  const queue = [...items];
  const released: string[] = [];
  const fake = {
    async dequeue(targetCloneId: string): Promise<WorkItem | null> {
      const idx = queue.findIndex(
        (i) => i.target_clone_id === targetCloneId && !i.claimed_at && !i.dead_letter,
      );
      if (idx === -1) return null;
      queue[idx]!.claimed_at = Date.now();
      return { ...queue[idx]! };
    },
    async complete(itemId: string): Promise<void> {
      const item = queue.find((i) => i.id === itemId);
      if (item) item.completed_at = Date.now();
    },
    async release(itemId: string, opts?: { maxAttempts?: number }): Promise<{ deadLettered: boolean }> {
      released.push(itemId);
      const item = queue.find((i) => i.id === itemId);
      if (!item) return { deadLettered: false };
      const max = opts?.maxAttempts ?? 3;
      const next = (item.attempts ?? 0) + 1;
      item.attempts = next;
      delete item.claimed_at;
      if (next >= max) {
        item.dead_letter = true;
        return { deadLettered: true };
      }
      return { deadLettered: false };
    },
    async enqueue() {
      throw new Error('not used in test');
    },
    async pending() {
      return queue.filter((i) => !i.claimed_at && !i.dead_letter);
    },
    released,
  };
  return fake as unknown as WorkQueueStore & { released: string[] };
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

  it('releases claimed item back to queue on runner failure (bug #27)', async () => {
    // Pre-fix: a runner failure left the item with claimed_at set forever —
    // dequeue's `!claimed_at` filter then skipped it, silently losing work.
    // Post-fix: daemon-loop calls workQueue.release(item.id) before continuing,
    // which clears claimed_at and increments attempts so the item is eligible
    // for re-dispatch. After maxAttempts the queue's release marks dead-letter.
    const item = makeWorkItem({ id: 'wq-release-test', target_clone_id: 'A' });
    const wq = makeFakeWorkQueue([item]);
    const result = await runDaemonLoop(
      makeOpts({
        workQueue: wq,
        runner: failRunner,
        maxResumeFailures: 1, // exit after the single failure for assertion clarity
      }),
    );
    expect(result.exitReason).toBe('max_failures');
    // The critical bug-#27 contract: release was called for the failed item.
    expect(wq.released).toContain('wq-release-test');
    // And the item is no longer in claimed-but-orphaned state — it's
    // re-dequeueable (the daemon exited, but the queue state proves work
    // was preserved, not lost).
    const reclaimable = await wq.dequeue('A');
    expect(reclaimable).not.toBeNull();
    expect(reclaimable!.id).toBe('wq-release-test');
    expect(reclaimable!.attempts).toBe(1);
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
