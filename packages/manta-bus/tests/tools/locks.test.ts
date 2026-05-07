import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FakeClock } from '../../src/clock';
import { busPaths } from '../../src/state/paths';
import { LocksStore } from '../../src/state/locks';
import { EventsLog } from '../../src/state/events';
import { makeTmpRoot } from '../helpers/tmpRoot';
import { createLockHandlers } from '../../src/tools/locks';
import { BusLockedError, BusNotFoundError, BusValidationError } from '../../src/errors';

describe('lock handlers', () => {
  let root: string;
  let cleanup: () => Promise<void>;
  let clock: FakeClock;
  let handlers: ReturnType<typeof createLockHandlers>;

  beforeEach(async () => {
    ({ root, cleanup } = await makeTmpRoot());
    clock = new FakeClock(1_000_000);
    const paths = busPaths(root);
    handlers = createLockHandlers({
      locks: new LocksStore(paths, clock, { staleAfterMs: 15_000 }),
      events: new EventsLog(paths, clock),
    });
  });
  afterEach(async () => {
    await cleanup();
  });

  it('lock acquires and emits event', async () => {
    const r = await handlers.lock({ clone_id: 'A', path: 'src/foo.ts' });
    expect(r.lease.owner_clone_id).toBe('A');
    expect(r.event.type).toBe('lock');
  });

  it('lock conflict raises BusLockedError', async () => {
    await handlers.lock({ clone_id: 'A', path: 'src/foo.ts' });
    await expect(handlers.lock({ clone_id: 'B', path: 'src/foo.ts' })).rejects.toBeInstanceOf(
      BusLockedError,
    );
  });

  it('renew_lock requires prior acquire', async () => {
    await expect(
      handlers.renew({ clone_id: 'A', path: 'src/foo.ts' }),
    ).rejects.toBeInstanceOf(BusNotFoundError);
  });

  it('renew_lock by owner refreshes the lease', async () => {
    await handlers.lock({ clone_id: 'A', path: 'src/foo.ts' });
    clock.advance(5_000);
    const r = await handlers.renew({ clone_id: 'A', path: 'src/foo.ts' });
    expect(r.lease.last_heartbeat_at).toBe(1_005_000);
    expect(r.event.type).toBe('renew_lock');
  });

  it('unlock releases and emits event', async () => {
    await handlers.lock({ clone_id: 'A', path: 'src/foo.ts' });
    const r = await handlers.unlock({ clone_id: 'A', path: 'src/foo.ts' });
    expect(r.event.type).toBe('unlock');
  });

  it('lock rejects invalid path', async () => {
    await expect(
      handlers.lock({ clone_id: 'A', path: '../escape' }),
    ).rejects.toBeInstanceOf(BusValidationError);
  });
});
