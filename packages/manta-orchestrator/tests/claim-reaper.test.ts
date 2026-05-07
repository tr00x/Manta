import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
