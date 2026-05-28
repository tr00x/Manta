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
    ctx.clock.advance(defaultThresholds.heartbeatTimeoutMs + 1_000);
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

  it('runCycle skips post-mortem when a stale-detected clone heartbeats mid-cycle (bug #38 — no DEAD-lock of live clones)', async () => {
    // Race scenario the bug describes: findDeadClones() reads the registry
    // outside any lock (sees `last_heartbeat=T0`, decides the clone is
    // stale). Before runPostMortem's markDead executes its mutator, the
    // clone resumes and heartbeats (T1 > T0). Pre-fix: markDead unconditionally
    // overwrote state → live clone permanently DEAD-locked (heartbeat rejects
    // DEAD). Post-fix: markDead's inside-mutex liveness recheck throws
    // BusConflictError; runPostMortem propagates; orchestrator's per-iteration
    // catch swallows it; cycle continues; clone stays WORKING.
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    await ctx.registry.heartbeat({ clone_id: 'A', state: 'WORKING' });
    ctx.clock.advance(defaultThresholds.heartbeatTimeoutMs + 1_000);

    // Inject the race: when post-mortem calls registry.get to fetch the
    // record, fire a heartbeat (clone resumes) just before returning. The
    // record returned reflects pre-resumption state, so runPostMortem passes
    // the stale `observedLastHeartbeatAt` into markDead.
    const realRegistry = ctx.registry;
    const racingRegistry = new Proxy(realRegistry, {
      get(target, prop) {
        if (prop === 'get') {
          return async (id: string) => {
            const r = await target.get(id);
            await target.heartbeat({ clone_id: id, state: 'WORKING' });
            return r;
          };
        }
        return (target as unknown as Record<PropertyKey, unknown>)[prop as string];
      },
    });
    const racingCtx = { ...ctx, registry: racingRegistry };
    const writer = inMemoryPostMortemWriter();
    const o = new Orchestrator({ ctx: racingCtx, thresholds: defaultThresholds, probe: makeProbe({ alive: () => true }), writer });

    const result = await o.runCycle(); // must NOT throw — the catch swallows BusConflictError
    expect(result.deadClones.map((d) => d.clone_id)).toEqual(['A']); // detector still flagged it
    expect(result.postMortems).toEqual([]); // ...but post-mortem skipped
    expect(writer.captured).toEqual([]); // no doc written for a live clone

    // Clone remains alive: state WORKING, no death recorded.
    const r = await realRegistry.get('A');
    expect(r.state).toBe('WORKING');
    expect(r.died_at).toBeUndefined();
    expect(r.death_reason).toBeUndefined();
  });

  it('runCycle is idempotent when called twice on the same state', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    await ctx.registry.heartbeat({ clone_id: 'A', state: 'WORKING' });
    ctx.clock.advance(defaultThresholds.heartbeatTimeoutMs + 1_000);
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

  it('runCycle reports idle clones in CycleResult', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    await ctx.registry.heartbeat({ clone_id: 'A', state: 'WORKING' });
    ctx.clock.advance(1_000);
    await ctx.registry.heartbeat({ clone_id: 'A', state: 'IDLE' });
    const writer = inMemoryPostMortemWriter();
    const o = new Orchestrator({ ctx, thresholds: defaultThresholds, probe: makeProbe({ alive: () => true }), writer });
    const result = await o.runCycle();
    expect(result.idleClones).toHaveLength(1);
    expect(result.idleClones[0]!.clone_id).toBe('A');
    expect(result.idleClones[0]!.idle_since).toBeDefined();
  });

  it('runCycle does NOT post-mortem IDLE clones within thresholds', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    await ctx.registry.heartbeat({ clone_id: 'A', state: 'WORKING' });
    ctx.clock.advance(1_000);
    await ctx.registry.heartbeat({ clone_id: 'A', state: 'IDLE' });
    ctx.clock.advance(10_000);
    const writer = inMemoryPostMortemWriter();
    const o = new Orchestrator({ ctx, thresholds: defaultThresholds, probe: makeProbe({ alive: () => true }), writer });
    const result = await o.runCycle();
    expect(result.deadClones).toEqual([]);
    expect(writer.captured).toEqual([]);
    expect((await ctx.registry.get('A')).state).toBe('IDLE');
  });

  it('runCycle empty state returns empty idleClones', async () => {
    const writer = inMemoryPostMortemWriter();
    const o = new Orchestrator({ ctx, thresholds: defaultThresholds, probe: makeProbe({ alive: () => true }), writer });
    const result = await o.runCycle();
    expect(result.idleClones).toEqual([]);
  });
});
