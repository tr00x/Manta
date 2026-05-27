import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FakeClock } from '../../src/clock';
import { busPaths } from '../../src/state/paths';
import { ClaimsStore } from '../../src/state/claims';
import { EventsLog } from '../../src/state/events';
import { Registry } from '../../src/state/registry';
import { WorkQueueStore } from '../../src/state/work-queue';
import { makeTmpRoot } from '../helpers/tmpRoot';
import { createWorkHandlers } from '../../src/tools/work';
import { BusConflictError, BusValidationError } from '../../src/errors';

describe('work handlers', () => {
  let root: string;
  let cleanup: () => Promise<void>;
  let clock: FakeClock;
  let handlers: ReturnType<typeof createWorkHandlers>;

  beforeEach(async () => {
    ({ root, cleanup } = await makeTmpRoot());
    clock = new FakeClock(1_000_000);
    const paths = busPaths(root);
    const registry = new Registry(paths, clock);
    await registry.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: '/w',
      metadata: {},
    });
    await registry.register({
      clone_id: 'B',
      mode: 'recon-swarm',
      parent_pid: 2,
      worktree: '/w',
      metadata: {},
    });
    handlers = createWorkHandlers({
      claims: new ClaimsStore(paths, clock),
      events: new EventsLog(paths, clock),
      registry,
    });
  });
  afterEach(async () => {
    await cleanup();
  });

  it('claim succeeds for unclaimed item', async () => {
    const r = await handlers.claim({ clone_id: 'A', item: 'task-1', timeout_ms: 60_000 });
    expect(r.claim.owner_clone_id).toBe('A');
    expect(r.event.type).toBe('claim');
  });

  it('claim conflict raises BusConflictError', async () => {
    await handlers.claim({ clone_id: 'A', item: 'task-1', timeout_ms: 60_000 });
    await expect(
      handlers.claim({ clone_id: 'B', item: 'task-1', timeout_ms: 60_000 }),
    ).rejects.toBeInstanceOf(BusConflictError);
  });

  it('release by owner emits event', async () => {
    await handlers.claim({ clone_id: 'A', item: 'task-1', timeout_ms: 60_000 });
    const r = await handlers.release({ clone_id: 'A', item: 'task-1' });
    expect(r.event.type).toBe('release');
  });

  it('claim rejects invalid input', async () => {
    await expect(handlers.claim({ clone_id: 'A' })).rejects.toBeInstanceOf(BusValidationError);
  });

  it('release rejects invalid input', async () => {
    await expect(handlers.release({ clone_id: 'A' })).rejects.toBeInstanceOf(BusValidationError);
  });
});

describe('enqueue handler', () => {
  let root: string;
  let cleanup: () => Promise<void>;
  let clock: FakeClock;
  let handlers: ReturnType<typeof createWorkHandlers>;
  let wq: WorkQueueStore;

  beforeEach(async () => {
    ({ root, cleanup } = await makeTmpRoot());
    clock = new FakeClock(1_000_000);
    const paths = busPaths(root);
    const registry = new Registry(paths, clock);
    await registry.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: '/w',
      metadata: {},
    });
    wq = new WorkQueueStore(paths, clock);
    handlers = createWorkHandlers({
      claims: new ClaimsStore(paths, clock),
      events: new EventsLog(paths, clock),
      registry,
      workQueue: wq,
    });
  });
  afterEach(async () => {
    await cleanup();
  });

  it('enqueues work item and appends event', async () => {
    const result = await handlers.enqueue({
      cast_id: 'cast-1',
      target_clone_id: 'A',
      prompt: 'implement feature X',
      priority: 'normal',
    });
    expect(result.item.id).toMatch(/^wq-/);
    expect(result.item.prompt).toBe('implement feature X');
    expect(result.item.cast_id).toBe('cast-1');
    expect(result.event.type).toBe('enqueue_work');
    expect(result.event.payload).toMatchObject({
      item_id: result.item.id,
      cast_id: 'cast-1',
      priority: 'normal',
    });
  });

  it('enqueue defaults priority to normal', async () => {
    const result = await handlers.enqueue({
      cast_id: 'cast-1',
      target_clone_id: 'A',
      prompt: 'task without priority',
    });
    expect(result.item.priority).toBe('normal');
  });

  it('enqueue rejects invalid input', async () => {
    await expect(
      handlers.enqueue({ cast_id: 'cast-1' }),
    ).rejects.toBeInstanceOf(BusValidationError);
  });

  it('throws when workQueue is not configured', async () => {
    const paths = busPaths(root);
    const handlersNoWq = createWorkHandlers({
      claims: new ClaimsStore(paths, clock),
      events: new EventsLog(paths, clock),
      registry: new Registry(paths, clock),
    });
    await expect(
      handlersNoWq.enqueue({
        cast_id: 'cast-1',
        target_clone_id: 'A',
        prompt: 'test',
        priority: 'normal',
      }),
    ).rejects.toThrow(/WorkQueueStore not initialized/);
  });

  it('enqueued items appear in work queue pending', async () => {
    await handlers.enqueue({
      cast_id: 'cast-1',
      target_clone_id: 'A',
      prompt: 'task 1',
      priority: 'high',
    });
    const pending = await wq.pending('A');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.priority).toBe('high');
  });
});
