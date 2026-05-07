import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FakeClock } from '../../src/clock';
import { busPaths } from '../../src/state/paths';
import { ClaimsStore } from '../../src/state/claims';
import { makeTmpRoot } from '../helpers/tmpRoot';
import { BusConflictError } from '../../src/errors';

describe('ClaimsStore', () => {
  let root: string;
  let cleanup: () => Promise<void>;
  let clock: FakeClock;
  let claims: ClaimsStore;

  beforeEach(async () => {
    ({ root, cleanup } = await makeTmpRoot());
    clock = new FakeClock(1_000_000);
    claims = new ClaimsStore(busPaths(root), clock);
  });
  afterEach(async () => {
    await cleanup();
  });

  it('claim by first arrival succeeds', async () => {
    const c = await claims.claim({ clone_id: 'A', item: 'task-1', timeout_ms: 60_000 });
    expect(c.owner_clone_id).toBe('A');
    expect(c.expires_at).toBe(1_000_000 + 60_000);
  });

  it('second claim while first is fresh fails', async () => {
    await claims.claim({ clone_id: 'A', item: 'task-1', timeout_ms: 60_000 });
    await expect(
      claims.claim({ clone_id: 'B', item: 'task-1', timeout_ms: 60_000 }),
    ).rejects.toBeInstanceOf(BusConflictError);
  });

  it('claim re-by-same-owner refreshes the timeout', async () => {
    await claims.claim({ clone_id: 'A', item: 'task-1', timeout_ms: 60_000 });
    clock.advance(30_000);
    const c = await claims.claim({ clone_id: 'A', item: 'task-1', timeout_ms: 90_000 });
    expect(c.expires_at).toBe(1_030_000 + 90_000);
  });

  it('expired claim can be taken by anyone', async () => {
    await claims.claim({ clone_id: 'A', item: 'task-1', timeout_ms: 1_000 });
    clock.advance(1_001);
    const c = await claims.claim({ clone_id: 'B', item: 'task-1', timeout_ms: 1_000 });
    expect(c.owner_clone_id).toBe('B');
  });

  it('release by owner removes the claim', async () => {
    await claims.claim({ clone_id: 'A', item: 'task-1', timeout_ms: 60_000 });
    await claims.release({ clone_id: 'A', item: 'task-1' });
    const after = await claims.list();
    expect(after).toEqual([]);
  });

  it('release by non-owner fails', async () => {
    await claims.claim({ clone_id: 'A', item: 'task-1', timeout_ms: 60_000 });
    await expect(claims.release({ clone_id: 'B', item: 'task-1' })).rejects.toBeInstanceOf(BusConflictError);
  });

  it('release of unknown item is a no-op (idempotent)', async () => {
    await expect(claims.release({ clone_id: 'A', item: 'ghost' })).resolves.toBeUndefined();
  });

  it('list returns all live claims', async () => {
    await claims.claim({ clone_id: 'A', item: 'task-1', timeout_ms: 60_000 });
    await claims.claim({ clone_id: 'B', item: 'task-2', timeout_ms: 60_000 });
    const list = await claims.list();
    expect(list.map((c) => c.item).sort()).toEqual(['task-1', 'task-2']);
  });

  it('reapExpired removes expired claims and returns them', async () => {
    await claims.claim({ clone_id: 'A', item: 'task-1', timeout_ms: 1_000 });
    await claims.claim({ clone_id: 'B', item: 'task-2', timeout_ms: 60_000 });
    clock.advance(1_001);
    const reaped = await claims.reapExpired();
    expect(reaped.map((c) => c.item)).toEqual(['task-1']);
    const remaining = await claims.list();
    expect(remaining.map((c) => c.item)).toEqual(['task-2']);
  });
});
