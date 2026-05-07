import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { findDeadClones } from '../src/death-detector';
import { defaultThresholds } from '../src/thresholds';
import { makeProbe } from '../src/parent-pid';
import { buildBusContext, type TestBusContext } from './helpers/buildBusContext';

describe('death-detector', () => {
  let ctx: TestBusContext;

  beforeEach(async () => {
    ctx = await buildBusContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it('returns empty list when no clones registered', async () => {
    const result = await findDeadClones(ctx, {
      thresholds: defaultThresholds,
      probe: makeProbe({ alive: () => true }),
    });
    expect(result).toEqual([]);
  });

  it('marks heartbeat-stale clones as dead', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    ctx.clock.advance(31_000);
    const result = await findDeadClones(ctx, {
      thresholds: defaultThresholds,
      probe: makeProbe({ alive: () => true }),
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.clone_id).toBe('A');
    expect(result[0]!.reason).toMatch(/heartbeat/);
  });

  it('marks orphaned clones (parent dead) as dead even if heartbeat is fresh', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 999_999_999, worktree: '/w', metadata: {} });
    ctx.clock.advance(1_000); // not stale by heartbeat
    const result = await findDeadClones(ctx, {
      thresholds: defaultThresholds,
      probe: makeProbe({ alive: () => false }),
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.reason).toMatch(/parent/);
  });

  it('does not double-count: stale-and-orphaned reports a single record', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 999, worktree: '/w', metadata: {} });
    ctx.clock.advance(31_000);
    const result = await findDeadClones(ctx, {
      thresholds: defaultThresholds,
      probe: makeProbe({ alive: () => false }),
    });
    expect(result).toHaveLength(1);
    // Reason is composite when both triggers fire
    expect(result[0]!.reason).toMatch(/heartbeat/);
    expect(result[0]!.reason).toMatch(/parent/);
  });

  it('skips already-DEAD clones', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    await ctx.registry.markDead('A', 'prior');
    ctx.clock.advance(60_000);
    const result = await findDeadClones(ctx, {
      thresholds: defaultThresholds,
      probe: makeProbe({ alive: () => false }),
    });
    expect(result).toEqual([]);
  });

  it('honors parentPidCheckEnabled=false (skip parent probe entirely)', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 999, worktree: '/w', metadata: {} });
    ctx.clock.advance(1_000);
    const result = await findDeadClones(ctx, {
      thresholds: { ...defaultThresholds, parentPidCheckEnabled: false },
      probe: makeProbe({ alive: () => false }),
    });
    expect(result).toEqual([]);
  });
});
