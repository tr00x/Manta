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

  it('bug #70: a STARTING clone kept warm by the booting-ticker survives past startupGraceMs', async () => {
    // The spawner's booting-ticker (clone-spawner.ts) touches last_heartbeat_at
    // every 30s while STARTING, so a live-but-quiet cold boot keeps refreshing.
    // Simulate: advance time well past startupGraceMs but touch on the way, the
    // way the ticker would — the clone must NOT be reaped (it's alive, booting).
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    for (let elapsed = 0; elapsed < defaultThresholds.startupGraceMs * 2; elapsed += 30_000) {
      ctx.clock.advance(30_000);
      await ctx.registry.touch('A'); // booting-ticker keeps the heartbeat fresh
    }
    const result = await findDeadClones(ctx, {
      thresholds: defaultThresholds,
      probe: makeProbe({ alive: () => true }),
    });
    expect(result).toEqual([]);
  });

  it('bug #70: a clone wedged in STARTING is reaped by the absolute hard cap', async () => {
    // Even with the ticker keeping last_heartbeat_at fresh, a process that never
    // leaves STARTING is wedged. The hard cap (measured from registered_at) must
    // still reap it so a hung boot cannot tick forever.
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    // Keep the heartbeat perfectly fresh (ticker still firing) but blow past the
    // hard cap in wall-clock since registration.
    for (let elapsed = 0; elapsed <= defaultThresholds.startupHardCapMs + 30_000; elapsed += 30_000) {
      ctx.clock.advance(30_000);
      await ctx.registry.touch('A');
    }
    const result = await findDeadClones(ctx, {
      thresholds: defaultThresholds,
      probe: makeProbe({ alive: () => true }),
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.clone_id).toBe('A');
    expect(result[0]!.reason).toMatch(/startup hard cap/);
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

  // Bug #M18: a clone whose own `claude` process vanishes mid-work (OOM, SIGKILL,
  // crash) emits no death event. Its parent cast is still alive (so the parent-pid
  // check does NOT catch it) and its heartbeat won't go stale for up to 20 min on
  // a FIX mode — so it sits phantom-WORKING and a paired reviewer blocks forever.
  // #65 persists the clone's own pid; probe it so a vanished process is reaped in
  // the same cycle.
  it('M18: a WORKING clone whose own process vanished is reaped even though the parent is alive', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'pair-programming', parent_pid: 1, worktree: '/w', metadata: {} });
    await ctx.registry.recordClonePid('A', 4242);
    await ctx.registry.heartbeat({ clone_id: 'A', state: 'WORKING' });
    ctx.clock.advance(1_000); // heartbeat perfectly fresh — only the process death betrays it
    const result = await findDeadClones(ctx, {
      thresholds: defaultThresholds,
      // parent (pid 1) alive, clone's own pid (4242) dead
      probe: makeProbe({ alive: (pid) => pid !== 4242 }),
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.clone_id).toBe('A');
    expect(result[0]!.reason).toMatch(/process vanished/);
    expect(result[0]!.reason).toMatch(/clone pid 4242/);
    expect(result[0]!.reason).not.toMatch(/parent/); // parent is alive
  });

  it('M18: a WORKING clone whose own process is alive is NOT reaped', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'pair-programming', parent_pid: 1, worktree: '/w', metadata: {} });
    await ctx.registry.recordClonePid('A', 4242);
    await ctx.registry.heartbeat({ clone_id: 'A', state: 'WORKING' });
    ctx.clock.advance(1_000);
    const result = await findDeadClones(ctx, {
      thresholds: defaultThresholds,
      probe: makeProbe({ alive: () => true }), // both pids alive
    });
    expect(result).toEqual([]);
  });

  it('M18: vanished-process reap honors parentPidCheckEnabled=false (no pid-based reaping)', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'pair-programming', parent_pid: 1, worktree: '/w', metadata: {} });
    await ctx.registry.recordClonePid('A', 4242);
    await ctx.registry.heartbeat({ clone_id: 'A', state: 'WORKING' });
    ctx.clock.advance(1_000);
    const result = await findDeadClones(ctx, {
      thresholds: { ...defaultThresholds, parentPidCheckEnabled: false },
      probe: makeProbe({ alive: (pid) => pid !== 4242 }), // clone pid dead but checks disabled
    });
    expect(result).toEqual([]);
  });

  it('M18: a clone with NO recorded clone_pid is not reaped on the vanished path (register→record window)', async () => {
    // Between register and the spawner's recordClonePid, clone_pid is undefined.
    // The probe returning "dead for everything" must NOT manufacture a vanished
    // reap from an absent pid — the heartbeat/grace logic governs that window.
    await ctx.registry.register({ clone_id: 'A', mode: 'pair-programming', parent_pid: 1, worktree: '/w', metadata: {} });
    await ctx.registry.heartbeat({ clone_id: 'A', state: 'WORKING' });
    ctx.clock.advance(1_000); // fresh heartbeat, no clone_pid recorded yet
    const result = await findDeadClones(ctx, {
      thresholds: defaultThresholds,
      // parent (pid 1) alive so the parent check is silent; clone_pid absent
      probe: makeProbe({ alive: (pid) => pid === 1 }),
    });
    expect(result).toEqual([]);
  });

  it('M18: a long-dead WORKING clone joins both reasons (stale heartbeat AND vanished pid), one finding', async () => {
    // The realistic case: the process died minutes ago, so BOTH the heartbeat is
    // stale AND the pid is gone. Must report a SINGLE record whose reason names
    // both — not two findings, not a swallowed signal.
    await ctx.registry.register({ clone_id: 'A', mode: 'pair-programming', parent_pid: 1, worktree: '/w', metadata: {} });
    await ctx.registry.recordClonePid('A', 4242);
    await ctx.registry.heartbeat({ clone_id: 'A', state: 'WORKING' });
    ctx.clock.advance(defaultThresholds.heartbeatTimeoutMs + 1_000); // heartbeat now stale too
    const result = await findDeadClones(ctx, {
      thresholds: defaultThresholds,
      probe: makeProbe({ alive: (pid) => pid !== 4242 }), // parent alive, clone gone
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.reason).toMatch(/heartbeat/);
    expect(result[0]!.reason).toMatch(/process vanished/);
  });

  it('M18: once the vanished writer is DEAD, its blocked reviewer is freed (reaped on idle)', async () => {
    // End-to-end shape of the #M18 wedge: writer A's process vanishes, reviewer B
    // waits forever. Cycle 1 reaps A (vanished pid). After A is marked DEAD,
    // B's `waitingOnLiveWriter` protection lapses and B is reaped on maxIdleTimeMs.
    await ctx.registry.register({ clone_id: 'A', mode: 'pair-programming', parent_pid: 1, worktree: '/wa', metadata: { role: 'writer' } });
    await ctx.registry.register({ clone_id: 'B', mode: 'pair-programming', parent_pid: 1, worktree: '/wb', metadata: { role: 'reviewer' } });
    await ctx.registry.recordClonePid('A', 4242);
    await ctx.registry.heartbeat({ clone_id: 'A', state: 'WORKING' });
    await ctx.registry.heartbeat({ clone_id: 'B', state: 'WORKING' });
    ctx.clock.advance(1_000);
    await ctx.registry.heartbeat({ clone_id: 'B', state: 'IDLE' }); // reviewer waits for writer
    ctx.clock.advance(defaultThresholds.maxIdleTimeMs + 60_000);
    await ctx.registry.touch('B'); // keep B's heartbeat fresh; only idle_since is stale
    const probe = makeProbe({ alive: (pid) => pid !== 4242 }); // A's process gone

    // Cycle 1: A reaped as vanished; B still protected (A not yet DEAD in registry).
    const cycle1 = await findDeadClones(ctx, { thresholds: defaultThresholds, probe });
    expect(cycle1.find((r) => r.clone_id === 'A')?.reason).toMatch(/process vanished/);
    expect(cycle1.find((r) => r.clone_id === 'B')).toBeUndefined();

    // Orchestrator marks A DEAD, then the next cycle frees B.
    await ctx.registry.markDead('A', cycle1.find((r) => r.clone_id === 'A')!.reason);
    const cycle2 = await findDeadClones(ctx, { thresholds: defaultThresholds, probe });
    expect(cycle2.find((r) => r.clone_id === 'B')?.reason).toMatch(/maxIdleTimeMs/);
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

  // Bug #M11: a pair-programming reviewer goes IDLE waiting for the writer's
  // first commit_ready. The writer's first batch is inherently > maxIdleTimeMs,
  // so the reviewer was guaranteed to be reaped first and the pair silently
  // degraded to a lone writer. A reviewer must NOT be reaped on maxIdleTimeMs
  // while its paired writer is still alive.
  it('M11: reviewer NOT reaped on maxIdleTimeMs while its writer is alive', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'pair-programming', parent_pid: 1, worktree: '/wa', metadata: { role: 'writer' } });
    await ctx.registry.register({ clone_id: 'B', mode: 'pair-programming', parent_pid: 1, worktree: '/wb', metadata: { role: 'reviewer' } });
    await ctx.registry.heartbeat({ clone_id: 'A', state: 'WORKING' });
    await ctx.registry.heartbeat({ clone_id: 'B', state: 'WORKING' });
    ctx.clock.advance(1_000);
    await ctx.registry.heartbeat({ clone_id: 'B', state: 'IDLE' }); // reviewer waits for writer
    ctx.clock.advance(defaultThresholds.maxIdleTimeMs + 60_000); // well past 5 min
    await ctx.registry.touch('B'); // booting-ticker keeps heartbeat fresh
    const result = await findDeadClones(ctx, {
      thresholds: defaultThresholds,
      probe: makeProbe({ alive: () => true }),
    });
    expect(result.find((r) => r.clone_id === 'B')).toBeUndefined();
  });

  it('M11: reviewer IS reaped on maxIdleTimeMs once its writer is DEAD', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'pair-programming', parent_pid: 1, worktree: '/wa', metadata: { role: 'writer' } });
    await ctx.registry.register({ clone_id: 'B', mode: 'pair-programming', parent_pid: 1, worktree: '/wb', metadata: { role: 'reviewer' } });
    await ctx.registry.heartbeat({ clone_id: 'B', state: 'WORKING' });
    ctx.clock.advance(1_000);
    await ctx.registry.heartbeat({ clone_id: 'B', state: 'IDLE' });
    await ctx.registry.markDead('A', 'writer done'); // writer gone — reviewer no longer protected
    ctx.clock.advance(defaultThresholds.maxIdleTimeMs + 1_000);
    await ctx.registry.touch('B');
    const result = await findDeadClones(ctx, {
      thresholds: defaultThresholds,
      probe: makeProbe({ alive: () => true }),
    });
    expect(result.find((r) => r.clone_id === 'B')?.reason).toMatch(/maxIdleTimeMs/);
  });

  it('M11: a waiting reviewer is still reaped if its process hangs (idle-heartbeat timeout)', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'pair-programming', parent_pid: 1, worktree: '/wa', metadata: { role: 'writer' } });
    await ctx.registry.register({ clone_id: 'B', mode: 'pair-programming', parent_pid: 1, worktree: '/wb', metadata: { role: 'reviewer' } });
    await ctx.registry.heartbeat({ clone_id: 'B', state: 'WORKING' });
    ctx.clock.advance(1_000);
    await ctx.registry.heartbeat({ clone_id: 'B', state: 'IDLE' });
    // No touch — the reviewer process is genuinely hung; heartbeat goes stale.
    ctx.clock.advance(defaultThresholds.idleHeartbeatTimeoutMs + 1_000);
    const result = await findDeadClones(ctx, {
      thresholds: defaultThresholds,
      probe: makeProbe({ alive: () => true }),
    });
    expect(result.find((r) => r.clone_id === 'B')?.reason).toMatch(/idle heartbeat/);
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
