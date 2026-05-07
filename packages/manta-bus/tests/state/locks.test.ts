import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FakeClock } from '../../src/clock';
import { busPaths } from '../../src/state/paths';
import { LocksStore } from '../../src/state/locks';
import { makeTmpRoot } from '../helpers/tmpRoot';
import { BusLockedError, BusNotFoundError } from '../../src/errors';

describe('LocksStore', () => {
  let root: string;
  let cleanup: () => Promise<void>;
  let clock: FakeClock;
  let locks: LocksStore;

  beforeEach(async () => {
    ({ root, cleanup } = await makeTmpRoot());
    clock = new FakeClock(1_000_000);
    locks = new LocksStore(busPaths(root), clock, { staleAfterMs: 15_000 });
  });
  afterEach(async () => {
    await cleanup();
  });

  it('acquire lets a clone take a fresh path', async () => {
    const lease = await locks.acquire({ clone_id: 'A', path: 'src/foo.ts' });
    expect(lease.owner_clone_id).toBe('A');
    expect(lease.acquired_at).toBe(1_000_000);
    expect(lease.last_heartbeat_at).toBe(1_000_000);
  });

  it('acquire by another clone fails while the lease is fresh', async () => {
    await locks.acquire({ clone_id: 'A', path: 'src/foo.ts' });
    clock.advance(5_000);
    await expect(locks.acquire({ clone_id: 'B', path: 'src/foo.ts' })).rejects.toBeInstanceOf(BusLockedError);
  });

  it('acquire is idempotent for the same owner', async () => {
    await locks.acquire({ clone_id: 'A', path: 'src/foo.ts' });
    clock.advance(2_000);
    const lease = await locks.acquire({ clone_id: 'A', path: 'src/foo.ts' });
    expect(lease.owner_clone_id).toBe('A');
    expect(lease.last_heartbeat_at).toBe(1_002_000);
  });

  it('renew updates last_heartbeat_at for the owner', async () => {
    await locks.acquire({ clone_id: 'A', path: 'src/foo.ts' });
    clock.advance(4_000);
    const lease = await locks.renew({ clone_id: 'A', path: 'src/foo.ts' });
    expect(lease.last_heartbeat_at).toBe(1_004_000);
  });

  it('renew by non-owner fails', async () => {
    await locks.acquire({ clone_id: 'A', path: 'src/foo.ts' });
    await expect(locks.renew({ clone_id: 'B', path: 'src/foo.ts' })).rejects.toBeInstanceOf(BusLockedError);
  });

  it('renew of unknown lock fails', async () => {
    await expect(locks.renew({ clone_id: 'A', path: 'src/foo.ts' })).rejects.toBeInstanceOf(BusNotFoundError);
  });

  it('release by owner removes the lease', async () => {
    await locks.acquire({ clone_id: 'A', path: 'src/foo.ts' });
    await locks.release({ clone_id: 'A', path: 'src/foo.ts' });
    // can be reacquired by anyone
    const lease = await locks.acquire({ clone_id: 'B', path: 'src/foo.ts' });
    expect(lease.owner_clone_id).toBe('B');
  });

  it('release by non-owner fails', async () => {
    await locks.acquire({ clone_id: 'A', path: 'src/foo.ts' });
    await expect(locks.release({ clone_id: 'B', path: 'src/foo.ts' })).rejects.toBeInstanceOf(BusLockedError);
  });

  it('a stale lock can be acquired by a new owner (zombie cleanup)', async () => {
    await locks.acquire({ clone_id: 'A', path: 'src/foo.ts' });
    clock.advance(15_001);
    const lease = await locks.acquire({ clone_id: 'B', path: 'src/foo.ts' });
    expect(lease.owner_clone_id).toBe('B');
    expect(lease.acquired_at).toBe(1_000_000 + 15_001);
  });

  it('same owner re-acquire after staleAfterMs is idempotent (no fresh take of own lease)', async () => {
    // Regression test for Fix #2: pre-fix, if the existing lease was stale,
    // the same owner re-calling acquire() would silently reset acquired_at to
    // `now` — losing the continuous-hold signal. Post-fix: same-owner
    // re-acquire is always idempotent (acquired_at preserved, last_heartbeat_at
    // bumped) regardless of staleness.
    const first = await locks.acquire({ clone_id: 'A', path: 'src/foo.ts' });
    expect(first.acquired_at).toBe(1_000_000);
    clock.advance(15_001);
    const second = await locks.acquire({ clone_id: 'A', path: 'src/foo.ts' });
    expect(second.owner_clone_id).toBe('A');
    expect(second.acquired_at).toBe(1_000_000); // unchanged
    expect(second.last_heartbeat_at).toBe(1_000_000 + 15_001); // bumped
  });

  it('listOwned returns only leases owned by a clone', async () => {
    await locks.acquire({ clone_id: 'A', path: 'src/foo.ts' });
    await locks.acquire({ clone_id: 'B', path: 'src/bar.ts' });
    const a = await locks.listOwned('A');
    expect(a.map((l) => l.path)).toEqual(['src/foo.ts']);
  });

  it('reapStale removes leases whose last heartbeat is older than threshold', async () => {
    await locks.acquire({ clone_id: 'A', path: 'src/foo.ts' });
    await locks.acquire({ clone_id: 'B', path: 'src/bar.ts' });
    clock.advance(15_001);
    await locks.renew({ clone_id: 'B', path: 'src/bar.ts' });
    const reaped = await locks.reapStale();
    expect(reaped.map((l) => l.path)).toEqual(['src/foo.ts']);
    // A's lock is gone; B still owns bar
    const b = await locks.listOwned('B');
    expect(b.map((l) => l.path)).toEqual(['src/bar.ts']);
  });
});
