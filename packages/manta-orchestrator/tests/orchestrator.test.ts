import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Orchestrator } from '../src/orchestrator';
import { defaultThresholds } from '../src/thresholds';
import { makeProbe } from '../src/parent-pid';
import { inMemoryPostMortemWriter } from '../src/post-mortem-writer';
import { buildBusContext, type TestBusContext } from './helpers/buildBusContext';

describe('Orchestrator', () => {
  let ctx: TestBusContext;
  beforeEach(async () => { ctx = await buildBusContext(); });
  afterEach(async () => { await ctx.cleanup(); });

  it('runCycle on empty state is a no-op', async () => {
    const writer = inMemoryPostMortemWriter();
    const o = new Orchestrator({ ctx, thresholds: defaultThresholds, probe: makeProbe({ alive: () => true }), writer });
    const result = await o.runCycle();
    expect(result.deadClones).toEqual([]);
    expect(result.reapedLocks).toEqual([]);
    expect(result.reapedClaims).toEqual([]);
    expect(result.postMortems).toEqual([]);
    expect(writer.captured).toEqual([]);
  });

  it('runCycle marks heartbeat-stale clones DEAD and writes a post-mortem', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: { cast_id: 'cast-1' } });
    // Move out of STARTING via a real heartbeat so heartbeatTimeoutMs (not startupGraceMs) applies.
    await ctx.registry.heartbeat({ clone_id: 'A', state: 'WORKING' });
    ctx.clock.advance(31_000);
    const writer = inMemoryPostMortemWriter();
    const o = new Orchestrator({ ctx, thresholds: defaultThresholds, probe: makeProbe({ alive: () => true }), writer });
    const result = await o.runCycle();
    expect(result.deadClones.map((d) => d.clone_id)).toEqual(['A']);
    expect(writer.captured).toHaveLength(1);
    const r = await ctx.registry.get('A');
    expect(r.state).toBe('DEAD');
  });

  it('runCycle reaps stale locks and emits events', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    await ctx.locks.acquire({ clone_id: 'A', path: 'src/foo.ts' });
    ctx.clock.advance(15_001);
    const writer = inMemoryPostMortemWriter();
    const o = new Orchestrator({ ctx, thresholds: defaultThresholds, probe: makeProbe({ alive: () => true }), writer });
    const result = await o.runCycle();
    expect(result.reapedLocks.map((l) => l.path)).toEqual(['src/foo.ts']);
  });

  it('runCycle reaps expired claims', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    await ctx.claims.claim({ clone_id: 'A', item: 'task-1', timeout_ms: 1_000 });
    ctx.clock.advance(1_001);
    const writer = inMemoryPostMortemWriter();
    const o = new Orchestrator({ ctx, thresholds: defaultThresholds, probe: makeProbe({ alive: () => true }), writer });
    const result = await o.runCycle();
    expect(result.reapedClaims.map((c) => c.item)).toEqual(['task-1']);
  });

  it('runCycle handles parent-PID death even when heartbeat is fresh', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 999, worktree: '/w', metadata: {} });
    ctx.clock.advance(1_000);
    const writer = inMemoryPostMortemWriter();
    const o = new Orchestrator({
      ctx, thresholds: defaultThresholds, probe: makeProbe({ alive: () => false }), writer,
    });
    const result = await o.runCycle();
    expect(result.deadClones.map((d) => d.clone_id)).toEqual(['A']);
    expect(result.deadClones[0]!.reason).toMatch(/parent/);
  });

  it('runCycle is idempotent when called twice on the same state', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    await ctx.registry.heartbeat({ clone_id: 'A', state: 'WORKING' });
    ctx.clock.advance(31_000);
    const writer = inMemoryPostMortemWriter();
    const o = new Orchestrator({ ctx, thresholds: defaultThresholds, probe: makeProbe({ alive: () => true }), writer });
    const first = await o.runCycle();
    const second = await o.runCycle();
    expect(first.deadClones).toHaveLength(1);
    expect(second.deadClones).toHaveLength(0); // already DEAD on the second pass
    expect(writer.captured).toHaveLength(1);
  });

  it('getStatus returns a coherent snapshot', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    const o = new Orchestrator({
      ctx, thresholds: defaultThresholds, probe: makeProbe({ alive: () => true }), writer: inMemoryPostMortemWriter(),
    });
    const s = await o.getStatus();
    expect(s.clones.map((c) => c.clone_id)).toEqual(['A']);
  });

  it('runCycle wraps unexpected errors in OrchestratorError without leaving partial state', async () => {
    // Simulate failure by injecting a probe that throws inside findDeadClones
    const writer = inMemoryPostMortemWriter();
    const o = new Orchestrator({
      ctx,
      thresholds: defaultThresholds,
      probe: { alive: () => { throw new Error('probe blew up'); } },
      writer,
    });
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    ctx.clock.advance(1_000);
    await expect(o.runCycle()).rejects.toMatchObject({ name: 'OrchestratorError', kind: 'cycle_failed' });

    // Fail-fast contract: nothing visible to a subsequent cycle.
    // Specifically: no lock_reap / claim_reap / post_mortem events emitted,
    // and no post-mortem written. (The probe throws BEFORE reapers run, so
    // findDeadClones is the only step that executed and it produced no
    // observable state mutation.)
    expect(writer.captured).toEqual([]);
    const events = await ctx.events.readAll();
    const types = events.map((e) => e.type);
    expect(types).not.toContain('lock_reap');
    expect(types).not.toContain('claim_reap');
    expect(types).not.toContain('post_mortem');
    // Registry untouched — A is still alive
    expect((await ctx.registry.get('A')).state).not.toBe('DEAD');
  });
});
