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

  it('marks heartbeat-stale clones as dead (state=WORKING after first heartbeat)', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    // Move out of STARTING via a real heartbeat; only after that does the heartbeat threshold apply.
    await ctx.registry.heartbeat({ clone_id: 'A', state: 'WORKING' });
    ctx.clock.advance(defaultThresholds.heartbeatTimeoutMs + 1_000);
    const result = await findDeadClones(ctx, {
      thresholds: defaultThresholds,
      probe: makeProbe({ alive: () => true }),
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.clone_id).toBe('A');
    expect(result[0]!.reason).toMatch(/heartbeat/);
  });

  it('STARTING clones get startup grace period (no DEAD before grace expires)', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    ctx.clock.advance(defaultThresholds.startupGraceMs - 1_000);
    const within = await findDeadClones(ctx, {
      thresholds: defaultThresholds,
      probe: makeProbe({ alive: () => true }),
    });
    expect(within).toEqual([]);
  });

  it('STARTING clones DO die once startup grace exceeded', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    ctx.clock.advance(defaultThresholds.startupGraceMs + 1_000);
    const result = await findDeadClones(ctx, {
      thresholds: defaultThresholds,
      probe: makeProbe({ alive: () => true }),
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.clone_id).toBe('A');
    expect(result[0]!.reason).toMatch(/startup grace/);
  });

  it('marks orphaned clones (parent dead) as dead even if heartbeat is fresh', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 999_999_999, worktree: '/w', metadata: {} });
    await ctx.registry.heartbeat({ clone_id: 'A', state: 'WORKING' });
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
    await ctx.registry.heartbeat({ clone_id: 'A', state: 'WORKING' });
    ctx.clock.advance(defaultThresholds.heartbeatTimeoutMs + 1_000);
    const result = await findDeadClones(ctx, {
      thresholds: defaultThresholds,
      probe: makeProbe({ alive: () => false }),
    });
    expect(result).toHaveLength(1);
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
    await ctx.registry.heartbeat({ clone_id: 'A', state: 'WORKING' });
    ctx.clock.advance(1_000);
    const result = await findDeadClones(ctx, {
      thresholds: { ...defaultThresholds, parentPidCheckEnabled: false },
      probe: makeProbe({ alive: () => false }),
    });
    expect(result).toEqual([]);
  });

  it('IDLE clone NOT killed within maxIdleTimeMs and idleHeartbeatTimeoutMs', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    await ctx.registry.heartbeat({ clone_id: 'A', state: 'WORKING' });
    ctx.clock.advance(1_000);
    await ctx.registry.heartbeat({ clone_id: 'A', state: 'IDLE' });
    ctx.clock.advance(defaultThresholds.maxIdleTimeMs - 1_000);
    const result = await findDeadClones(ctx, {
      thresholds: defaultThresholds,
      probe: makeProbe({ alive: () => true }),
    });
    expect(result).toEqual([]);
  });

  it('IDLE clone killed when heartbeat exceeds idleHeartbeatTimeoutMs', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    await ctx.registry.heartbeat({ clone_id: 'A', state: 'WORKING' });
    ctx.clock.advance(1_000);
    await ctx.registry.heartbeat({ clone_id: 'A', state: 'IDLE' });
    ctx.clock.advance(defaultThresholds.idleHeartbeatTimeoutMs + 1_000);
    const result = await findDeadClones(ctx, {
      thresholds: defaultThresholds,
      probe: makeProbe({ alive: () => true }),
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.reason).toMatch(/idle heartbeat/);
  });

  it('IDLE clone killed when idle exceeds maxIdleTimeMs', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    await ctx.registry.heartbeat({ clone_id: 'A', state: 'WORKING' });
    ctx.clock.advance(1_000);
    await ctx.registry.heartbeat({ clone_id: 'A', state: 'IDLE' });
    ctx.clock.advance(10_000);
    await ctx.registry.touch('A');
    ctx.clock.advance(defaultThresholds.maxIdleTimeMs + 1_000);
    const result = await findDeadClones(ctx, {
      thresholds: defaultThresholds,
      probe: makeProbe({ alive: () => true }),
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.reason).toMatch(/maxIdleTimeMs/);
  });

  it('WAITING_FOR_TASK clone uses extended timeout', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    await ctx.registry.heartbeat({ clone_id: 'A', state: 'WAITING_FOR_TASK' });
    ctx.clock.advance(defaultThresholds.heartbeatTimeoutMs + 1_000);
    const result = await findDeadClones(ctx, {
      thresholds: defaultThresholds,
      probe: makeProbe({ alive: () => true }),
    });
    expect(result).toEqual([]);
  });

  it('daemon clone killed when session exceeds daemonMaxLifetimeMs', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    await ctx.registry.heartbeat({ clone_id: 'A', state: 'WORKING' });
    const fs = await import('node:fs/promises');
    const regPath = ctx.paths.registry;
    const regFile = JSON.parse(await fs.readFile(regPath, 'utf8')) as { clones: Record<string, unknown> };
    (regFile.clones['A'] as Record<string, unknown>).session_mode = 'daemon';
    await fs.writeFile(regPath, JSON.stringify(regFile), 'utf8');
    ctx.clock.advance(defaultThresholds.daemonMaxLifetimeMs + 1_000);
    const result = await findDeadClones(ctx, {
      thresholds: defaultThresholds,
      probe: makeProbe({ alive: () => true }),
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.reason).toMatch(/daemonMaxLifetimeMs/);
  });

  it('batch clone NOT affected by daemon lifetime threshold', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    await ctx.registry.heartbeat({ clone_id: 'A', state: 'WORKING' });
    ctx.clock.advance(1_000);
    await ctx.registry.heartbeat({ clone_id: 'A', state: 'WORKING' });
    const result = await findDeadClones(ctx, {
      thresholds: defaultThresholds,
      probe: makeProbe({ alive: () => true }),
    });
    expect(result).toEqual([]);
  });
});
