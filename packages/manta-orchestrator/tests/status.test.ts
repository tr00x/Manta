import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildStatus } from '../src/status';
import { defaultThresholds } from '../src/thresholds';
import { buildBusContext, type TestBusContext } from './helpers/buildBusContext';

describe('status', () => {
  let ctx: TestBusContext;
  beforeEach(async () => { ctx = await buildBusContext(); });
  afterEach(async () => { await ctx.cleanup(); });

  it('returns empty snapshot when nothing registered', async () => {
    const s = await buildStatus(ctx, { thresholds: defaultThresholds });
    expect(s.now).toBe(1_000_000);
    expect(s.clones).toEqual([]);
    expect(s.locks).toEqual([]);
    expect(s.claims).toEqual([]);
    expect(s.thresholds).toEqual(defaultThresholds);
  });

  it('reports registered clones, locks, claims', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    await ctx.locks.acquire({ clone_id: 'A', path: 'src/foo.ts' });
    await ctx.claims.claim({ clone_id: 'A', item: 'task-1', timeout_ms: 60_000 });
    const s = await buildStatus(ctx, { thresholds: defaultThresholds });
    expect(s.clones.map((c) => c.clone_id)).toEqual(['A']);
    expect(s.locks.map((l) => l.path)).toEqual(['src/foo.ts']);
    expect(s.claims.map((c) => c.item)).toEqual(['task-1']);
  });
});
