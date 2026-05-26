import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Orchestrator } from '../src/orchestrator';
import { defaultThresholds } from '../src/thresholds';
import { makeProbe } from '../src/parent-pid';
import { fsPostMortemWriter } from '../src/post-mortem-writer';
import { buildBusContext, type TestBusContext } from './helpers/buildBusContext';

describe('orchestrator integration (real @manta/bus, real fs)', () => {
  let ctx: TestBusContext;
  beforeEach(async () => { ctx = await buildBusContext(); });
  afterEach(async () => { await ctx.cleanup(); });

  it('detects dead clone, marks DEAD, reaps locks, writes a post-mortem on disk', async () => {
    // 1. Register A and have it heartbeat once, lock a path, claim a work item.
    await ctx.registry.register({
      clone_id: 'A', mode: 'recon-swarm', parent_pid: process.pid,
      worktree: ctx.root, metadata: { cast_id: 'cast-X' },
    });
    await ctx.registry.heartbeat({ clone_id: 'A', state: 'WORKING', progress: 'mid' });
    await ctx.locks.acquire({ clone_id: 'A', path: 'src/index.ts' });
    await ctx.claims.claim({ clone_id: 'A', item: 'analyze', timeout_ms: 60_000 });

    // 2. Time passes — heartbeat goes stale, lock goes stale, claim goes stale.
    ctx.clock.advance(defaultThresholds.heartbeatTimeoutMs + 1_000);

    // 3. Run a cycle with a real fs writer.
    const writer = fsPostMortemWriter({ repoRoot: ctx.root, postMortemDir: 'docs/post-mortems' });
    const o = new Orchestrator({
      ctx, thresholds: defaultThresholds, probe: makeProbe({ alive: () => true }), writer,
    });
    const result = await o.runCycle();

    // 4. Assert all four planes acted.
    expect(result.deadClones.map((d) => d.clone_id)).toEqual(['A']);
    expect(result.reapedLocks.map((l) => l.path)).toEqual(['src/index.ts']);
    expect(result.reapedClaims.map((c) => c.item)).toEqual(['analyze']);
    expect(result.postMortems).toHaveLength(1);

    // 5. Disk artifacts exist.
    const pmDir = path.join(ctx.root, 'docs', 'post-mortems');
    const files = await fs.readdir(pmDir);
    expect(files).toHaveLength(1);
    const pmContent = await fs.readFile(path.join(pmDir, files[0]!), 'utf8');
    expect(pmContent).toContain('# Post-mortem — clone A');
    expect(pmContent).toContain('cast-X');

    // 6. Bus state reflects death.
    const r = await ctx.registry.get('A');
    expect(r.state).toBe('DEAD');

    // 7. Events log shows lock_reap and claim_reap BEFORE post_mortem
    //    (cycle order: detect → reap-locks → reap-claims → post-mortem).
    //    Asserting indices catches a future refactor that reorders phases.
    const events = await ctx.events.readAll();
    const types = events.map((e) => e.type);
    expect(types).toContain('lock_reap');
    expect(types).toContain('claim_reap');
    expect(types).toContain('post_mortem');
    expect(types.indexOf('post_mortem')).toBeGreaterThan(types.indexOf('lock_reap'));
    expect(types.indexOf('post_mortem')).toBeGreaterThan(types.indexOf('claim_reap'));
  });

  it('does nothing on a healthy state', async () => {
    await ctx.registry.register({
      clone_id: 'A', mode: 'recon-swarm', parent_pid: process.pid,
      worktree: ctx.root, metadata: {},
    });
    const writer = fsPostMortemWriter({ repoRoot: ctx.root, postMortemDir: 'docs/post-mortems' });
    const o = new Orchestrator({
      ctx, thresholds: defaultThresholds, probe: makeProbe({ alive: () => true }), writer,
    });
    const result = await o.runCycle();
    expect(result.deadClones).toEqual([]);
    expect(result.reapedLocks).toEqual([]);
    expect(result.reapedClaims).toEqual([]);
    expect(result.postMortems).toEqual([]);
    // No post-mortem dir created
    await expect(fs.access(path.join(ctx.root, 'docs/post-mortems'))).rejects.toThrow();
  });
});
