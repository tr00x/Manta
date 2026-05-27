import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FakeClock } from '../../src/clock';
import { busPaths } from '../../src/state/paths';
import { WorkQueueStore } from '../../src/state/work-queue';
import { makeTmpRoot } from '../helpers/tmpRoot';

describe('WorkQueueStore', () => {
  let root: string;
  let cleanup: () => Promise<void>;
  let clock: FakeClock;
  let store: WorkQueueStore;

  beforeEach(async () => {
    ({ root, cleanup } = await makeTmpRoot());
    clock = new FakeClock(1_000_000);
    store = new WorkQueueStore(busPaths(root), clock);
  });
  afterEach(async () => {
    await cleanup();
  });

  it('enqueue returns a work item with generated id', async () => {
    const item = await store.enqueue({
      cast_id: 'cast-1',
      target_clone_id: 'A',
      prompt: 'write tests',
      priority: 'normal',
    });
    expect(item.id).toMatch(/^wq-/);
    expect(item.cast_id).toBe('cast-1');
    expect(item.target_clone_id).toBe('A');
    expect(item.prompt).toBe('write tests');
    expect(item.priority).toBe('normal');
    expect(item.enqueued_at).toBe(1_000_000);
    expect(item.claimed_at).toBeUndefined();
  });

  it('dequeue returns the first unclaimed item for target', async () => {
    await store.enqueue({ cast_id: 'cast-1', target_clone_id: 'A', prompt: 'first', priority: 'normal' });
    clock.advance(1_000);
    await store.enqueue({ cast_id: 'cast-1', target_clone_id: 'A', prompt: 'second', priority: 'normal' });
    const item = await store.dequeue('A');
    expect(item).not.toBeNull();
    expect(item!.prompt).toBe('first');
    expect(item!.claimed_at).toBe(1_001_000);
  });

  it('dequeue returns null when no items for target', async () => {
    await store.enqueue({ cast_id: 'cast-1', target_clone_id: 'B', prompt: 'not for A', priority: 'normal' });
    const item = await store.dequeue('A');
    expect(item).toBeNull();
  });

  it('dequeue prioritizes high-priority items', async () => {
    await store.enqueue({ cast_id: 'cast-1', target_clone_id: 'A', prompt: 'normal task', priority: 'normal' });
    clock.advance(1_000);
    await store.enqueue({ cast_id: 'cast-1', target_clone_id: 'A', prompt: 'urgent task', priority: 'high' });
    const item = await store.dequeue('A');
    expect(item!.prompt).toBe('urgent task');
  });

  it('complete marks an item as completed', async () => {
    const item = await store.enqueue({ cast_id: 'cast-1', target_clone_id: 'A', prompt: 'task', priority: 'normal' });
    await store.dequeue('A');
    clock.advance(5_000);
    await store.complete(item.id);
    const pending = await store.pending('A');
    expect(pending).toEqual([]);
  });

  it('pending returns only unclaimed items', async () => {
    await store.enqueue({ cast_id: 'cast-1', target_clone_id: 'A', prompt: 'task-1', priority: 'normal' });
    clock.advance(1_000);
    await store.enqueue({ cast_id: 'cast-1', target_clone_id: 'A', prompt: 'task-2', priority: 'normal' });
    await store.dequeue('A');
    const pending = await store.pending('A');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.prompt).toBe('task-2');
  });

  it('dequeue skips already-claimed items', async () => {
    await store.enqueue({ cast_id: 'cast-1', target_clone_id: 'A', prompt: 'task-1', priority: 'normal' });
    clock.advance(1_000);
    await store.enqueue({ cast_id: 'cast-1', target_clone_id: 'A', prompt: 'task-2', priority: 'normal' });
    await store.dequeue('A');
    clock.advance(1_000);
    const second = await store.dequeue('A');
    expect(second!.prompt).toBe('task-2');
  });

  it('dequeue returns null on empty queue', async () => {
    const item = await store.dequeue('A');
    expect(item).toBeNull();
  });
});
