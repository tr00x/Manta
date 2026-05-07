import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { reapLocks } from '../src/lock-reaper';
import { buildBusContext, type TestBusContext } from './helpers/buildBusContext';

describe('lock-reaper', () => {
  let ctx: TestBusContext;
  beforeEach(async () => {
    ctx = await buildBusContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it('returns empty when no locks exist', async () => {
    const result = await reapLocks(ctx);
    expect(result.reaped).toEqual([]);
    expect(result.events).toEqual([]);
  });

  it('reaps stale locks and emits one lock_reap event per lease', async () => {
    await ctx.locks.acquire({ clone_id: 'A', path: 'src/foo.ts' });
    await ctx.locks.acquire({ clone_id: 'B', path: 'src/bar.ts' });
    ctx.clock.advance(15_001);
    await ctx.locks.renew({ clone_id: 'B', path: 'src/bar.ts' }); // B refreshes; A goes stale
    const result = await reapLocks(ctx);
    expect(result.reaped.map((l) => l.path)).toEqual(['src/foo.ts']);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.type).toBe('lock_reap');
    expect(result.events[0]!.payload).toMatchObject({ path: 'src/foo.ts', former_owner: 'A' });
  });

  it('emits no event when nothing was reaped', async () => {
    await ctx.locks.acquire({ clone_id: 'A', path: 'src/foo.ts' });
    const result = await reapLocks(ctx);
    expect(result.reaped).toEqual([]);
    expect(result.events).toEqual([]);
  });
});
