import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FakeClock } from '../../src/clock';
import { busPaths } from '../../src/state/paths';
import { ClaimsStore } from '../../src/state/claims';
import { EventsLog } from '../../src/state/events';
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
    handlers = createWorkHandlers({
      claims: new ClaimsStore(paths, clock),
      events: new EventsLog(paths, clock),
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
