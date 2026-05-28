import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { reapClaims } from '../src/claim-reaper';
import { buildBusContext, type TestBusContext } from './helpers/buildBusContext';

describe('claim-reaper', () => {
  let ctx: TestBusContext;
  beforeEach(async () => {
    ctx = await buildBusContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it('returns empty when no claims', async () => {
    const result = await reapClaims(ctx);
    expect(result.reaped).toEqual([]);
    expect(result.events).toEqual([]);
  });

  it('reaps expired claims and emits claim_reap events', async () => {
    await ctx.claims.claim({ clone_id: 'A', item: 'task-1', timeout_ms: 1_000 });
    await ctx.claims.claim({ clone_id: 'B', item: 'task-2', timeout_ms: 60_000 });
    ctx.clock.advance(1_001);
    const result = await reapClaims(ctx);
    expect(result.reaped.map((c) => c.item)).toEqual(['task-1']);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.type).toBe('claim_reap');
    expect(result.events[0]!.payload).toMatchObject({ item: 'task-1', former_owner: 'A' });
  });

  it('does not reap non-expired claims', async () => {
    await ctx.claims.claim({ clone_id: 'A', item: 'task-1', timeout_ms: 60_000 });
    ctx.clock.advance(30_000);
    const result = await reapClaims(ctx);
    expect(result.reaped).toEqual([]);
  });
});

describe('claim-reaper — audit-trail invariant (bug #24)', () => {
  // Bug #24 (mirror of lock-reaper case): `claims.reapExpired()` used to
  // commit state and then loop append outside the file mutex. The fix moves
  // the audit append inside the mutex via `atomicMutateJson`'s `auditAppend`
  // closure, so a crash between commit and audit cannot leave reaped claims
  // without a forensic trail.
  let ctx: TestBusContext;
  beforeEach(async () => {
    ctx = await buildBusContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it('failing events.append aborts the reaper commit (expired claims stay in store)', async () => {
    await ctx.claims.claim({ clone_id: 'A', item: 'task-1', timeout_ms: 1_000 });
    await ctx.claims.claim({ clone_id: 'B', item: 'task-2', timeout_ms: 1_000 });
    ctx.clock.advance(1_001);
    vi.spyOn(ctx.events, 'append').mockRejectedValueOnce(new Error('audit log full'));

    await expect(reapClaims(ctx)).rejects.toThrow(/audit log full/);

    const remaining = await ctx.claims.list();
    expect(remaining.map((c) => c.item).sort()).toEqual(['task-1', 'task-2']);
  });

  it('audit append fires before the reaper promise resolves', async () => {
    await ctx.claims.claim({ clone_id: 'A', item: 'task-1', timeout_ms: 1_000 });
    ctx.clock.advance(1_001);

    const appendCalls: string[] = [];
    const real = ctx.events.append.bind(ctx.events);
    vi.spyOn(ctx.events, 'append').mockImplementation(async (input) => {
      appendCalls.push(input.type);
      return real(input);
    });

    expect(appendCalls).toEqual([]);
    const result = await reapClaims(ctx);
    expect(result.reaped).toHaveLength(1);
    expect(appendCalls).toEqual(['claim_reap']);
  });

  it('multi-claim reap emits one audit per expired claim, all inside the mutex hold', async () => {
    await ctx.claims.claim({ clone_id: 'A', item: 'task-1', timeout_ms: 1_000 });
    await ctx.claims.claim({ clone_id: 'B', item: 'task-2', timeout_ms: 1_000 });
    await ctx.claims.claim({ clone_id: 'C', item: 'task-3', timeout_ms: 1_000 });
    ctx.clock.advance(1_001);

    const result = await reapClaims(ctx);
    expect(result.reaped).toHaveLength(3);
    expect(result.events.map((e) => e.type)).toEqual([
      'claim_reap',
      'claim_reap',
      'claim_reap',
    ]);
  });
});
