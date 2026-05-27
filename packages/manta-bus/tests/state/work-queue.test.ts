import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FakeClock } from '../../src/clock';
import { busPaths } from '../../src/state/paths';
import { WorkQueueStore } from '../../src/state/work-queue';
import { makeTmpRoot } from '../helpers/tmpRoot';

describe('WorkQueueStore', () => {
  let root: string;
  let cleanup: () => Promise<void>;
  let clock: FakeClock;
  let wq: WorkQueueStore;

  beforeEach(async () => {
    ({ root, cleanup } = await makeTmpRoot());
    clock = new FakeClock(1_000_000);
    wq = new WorkQueueStore(busPaths(root), clock);
  });
  afterEach(async () => {
    await cleanup();
  });

  it('enqueue creates a work item with correct fields', async () => {
    const item = await wq.enqueue({
      cast_id: 'cast-1',
      target_clone_id: 'A',
      prompt: 'do the thing',
      priority: 'normal',
    });
    expect(item.id).toMatch(/^wq-/);
    expect(item.cast_id).toBe('cast-1');
    expect(item.target_clone_id).toBe('A');
    expect(item.prompt).toBe('do the thing');
    expect(item.priority).toBe('normal');
    expect(item.enqueued_at).toBe(1_000_000);
    expect(item.claimed_at).toBeUndefined();
    expect(item.completed_at).toBeUndefined();
  });

  it('dequeue returns null when queue is empty', async () => {
    const item = await wq.dequeue('A');
    expect(item).toBeNull();
  });

  it('dequeue returns the first unclaimed item for the target clone', async () => {
    await wq.enqueue({ cast_id: 'c1', target_clone_id: 'A', prompt: 'first', priority: 'normal' });
    clock.advance(100);
    await wq.enqueue({ cast_id: 'c1', target_clone_id: 'A', prompt: 'second', priority: 'normal' });

    const item = await wq.dequeue('A');
    expect(item).not.toBeNull();
    expect(item!.prompt).toBe('first');
    expect(item!.claimed_at).toBe(1_000_100);
  });

  it('dequeue prioritizes high-priority items over normal', async () => {
    await wq.enqueue({ cast_id: 'c1', target_clone_id: 'A', prompt: 'normal-first', priority: 'normal' });
    clock.advance(100);
    await wq.enqueue({ cast_id: 'c1', target_clone_id: 'A', prompt: 'high-second', priority: 'high' });

    const item = await wq.dequeue('A');
    expect(item!.prompt).toBe('high-second');
  });

  it('dequeue does not return items for other clones', async () => {
    await wq.enqueue({ cast_id: 'c1', target_clone_id: 'B', prompt: 'for B', priority: 'normal' });
    const item = await wq.dequeue('A');
    expect(item).toBeNull();
  });

  it('dequeue does not return already-claimed items', async () => {
    await wq.enqueue({ cast_id: 'c1', target_clone_id: 'A', prompt: 'task', priority: 'normal' });
    await wq.dequeue('A');
    const second = await wq.dequeue('A');
    expect(second).toBeNull();
  });

  it('complete marks item with completed_at timestamp', async () => {
    await wq.enqueue({ cast_id: 'c1', target_clone_id: 'A', prompt: 'task', priority: 'normal' });
    clock.advance(100);
    const claimed = await wq.dequeue('A');
    expect(claimed).not.toBeNull();
    clock.advance(400);
    await wq.complete(claimed!.id);

    const pending = await wq.pending('A');
    expect(pending).toHaveLength(0);
  });

  it('pending returns only unclaimed items for target clone', async () => {
    await wq.enqueue({ cast_id: 'c1', target_clone_id: 'A', prompt: 'a1', priority: 'normal' });
    await wq.enqueue({ cast_id: 'c1', target_clone_id: 'B', prompt: 'b1', priority: 'normal' });
    clock.advance(100);
    await wq.enqueue({ cast_id: 'c1', target_clone_id: 'A', prompt: 'a2', priority: 'high' });

    const pendingA = await wq.pending('A');
    expect(pendingA).toHaveLength(2);
    expect(pendingA.map((i) => i.prompt).sort()).toEqual(['a1', 'a2']);

    const pendingB = await wq.pending('B');
    expect(pendingB).toHaveLength(1);
    expect(pendingB[0]!.prompt).toBe('b1');
  });

  it('pending excludes claimed items', async () => {
    await wq.enqueue({ cast_id: 'c1', target_clone_id: 'A', prompt: 'task', priority: 'normal' });
    await wq.dequeue('A');
    const pending = await wq.pending('A');
    expect(pending).toHaveLength(0);
  });
});
