import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

describe('lock-reaper — audit-trail invariant (bug #24)', () => {
  // Bug #24: the reaper used to commit state via `locks.reapStale()` and only
  // then fire `events.append('lock_reap', ...)`. A crash between the
  // tmp+rename commit and the first audit append would silently lose the
  // forensic record of who lost which lease. The fix moves the audit append
  // INSIDE the file mutex via `atomicMutateJson`'s `auditAppend` closure.
  let ctx: TestBusContext;
  beforeEach(async () => {
    ctx = await buildBusContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it('failing events.append aborts the reaper commit (stale leases stay in store)', async () => {
    await ctx.locks.acquire({ clone_id: 'A', path: 'src/foo.ts' });
    await ctx.locks.acquire({ clone_id: 'B', path: 'src/bar.ts' });
    ctx.clock.advance(15_001);
    vi.spyOn(ctx.events, 'append').mockRejectedValueOnce(new Error('audit log full'));

    await expect(reapLocks(ctx)).rejects.toThrow(/audit log full/);

    // Both leases must still be present — atomic-fs aborts the rename when
    // auditAppend throws, so the state file is unchanged.
    const remaining = (await ctx.locks.listOwned('A')).concat(
      await ctx.locks.listOwned('B'),
    );
    expect(remaining.map((l) => l.path).sort()).toEqual(['src/bar.ts', 'src/foo.ts']);
  });

  it('audit append fires before the reaper promise resolves (no post-commit window)', async () => {
    await ctx.locks.acquire({ clone_id: 'A', path: 'src/foo.ts' });
    ctx.clock.advance(15_001);

    // The audit invariant: by the time the reaper resolves, the audit line
    // for every reaped lease has already been written to events.jsonl.
    // Equivalently: a snapshot taken inside `events.append` must already see
    // the persisted state mutation (and vice versa). Easier check: spy on
    // the append, capture the call order, assert it occurred during (not
    // after) `reapLocks`.
    const appendCalls: string[] = [];
    const real = ctx.events.append.bind(ctx.events);
    vi.spyOn(ctx.events, 'append').mockImplementation(async (input) => {
      appendCalls.push(input.type);
      return real(input);
    });

    expect(appendCalls).toEqual([]);
    const result = await reapLocks(ctx);
    expect(result.reaped).toHaveLength(1);
    expect(appendCalls).toEqual(['lock_reap']);
    expect(result.events).toHaveLength(1);
  });

  it('multi-lease reap fires one audit per stale lease, all inside the same mutex hold', async () => {
    await ctx.locks.acquire({ clone_id: 'A', path: 'src/foo.ts' });
    await ctx.locks.acquire({ clone_id: 'B', path: 'src/bar.ts' });
    await ctx.locks.acquire({ clone_id: 'C', path: 'src/baz.ts' });
    ctx.clock.advance(15_001);

    const result = await reapLocks(ctx);
    expect(result.reaped).toHaveLength(3);
    expect(result.events.map((e) => e.type)).toEqual([
      'lock_reap',
      'lock_reap',
      'lock_reap',
    ]);
  });
});
