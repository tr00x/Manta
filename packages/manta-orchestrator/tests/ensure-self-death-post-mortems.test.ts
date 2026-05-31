import { describe, it, expect } from 'vitest';
import { ensureSelfDeathPostMortems } from '../src/post-mortem';
import { inMemoryPostMortemWriter } from '../src/post-mortem-writer';
import { defaultThresholds } from '../src/thresholds';
import {
  Registry,
  EventsLog,
  busPaths,
  systemClock,
  type BusContext,
} from '@manta/bus';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

type Ctx = Pick<BusContext, 'registry' | 'events' | 'clock'>;

async function makeCtx(): Promise<Ctx> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-settle-'));
  const paths = busPaths(root);
  await fs.mkdir(path.dirname(paths.registry), { recursive: true });
  return {
    registry: new Registry(paths, systemClock),
    events: new EventsLog(paths, systemClock),
    clock: systemClock,
  };
}

async function register(ctx: Ctx, id: string, castId: string): Promise<void> {
  await ctx.registry.register({
    clone_id: id,
    mode: 'recon-swarm',
    parent_pid: process.pid,
    worktree: `/tmp/wt-${id}`,
    metadata: { cast_id: castId },
  });
}

async function markDead(ctx: Ctx, id: string, reason: string): Promise<void> {
  const rec = await ctx.registry.get(id);
  await ctx.registry.markDead(id, reason, async () => {}, rec.last_heartbeat_at);
}

describe('ensureSelfDeathPostMortems', () => {
  it('writes a post-mortem for a DEAD self-reported clone lacking one', async () => {
    const ctx = await makeCtx();
    await register(ctx, 'A', 'cast-xyz');
    await markDead(ctx, 'A', 'self-reported death');
    const writer = inMemoryPostMortemWriter();

    const result = await ensureSelfDeathPostMortems(ctx, {
      cloneIds: ['A'],
      writer,
      thresholds: defaultThresholds,
      existingFilenames: [],
    });

    expect(result.written).toHaveLength(1);
    expect(result.skipped).toEqual([]);
    expect(writer.captured).toHaveLength(1);
    expect(writer.captured[0]!.filename).toMatch(/^\d{4}-\d{2}-\d{2}-cast-xyz-A\.md$/);
    expect(writer.captured[0]!.body).toContain('# Post-mortem — clone A');
  });

  it('skips clones that are not DEAD (still WORKING)', async () => {
    const ctx = await makeCtx();
    await register(ctx, 'A', 'cast-xyz');
    await markDead(ctx, 'A', 'done');
    await register(ctx, 'B', 'cast-xyz'); // alive (STARTING/WORKING), not DEAD
    const writer = inMemoryPostMortemWriter();

    const result = await ensureSelfDeathPostMortems(ctx, {
      cloneIds: ['A', 'B'],
      writer,
      thresholds: defaultThresholds,
      existingFilenames: [],
    });

    expect(result.written.map((w) => w.document.filename)).toEqual([
      expect.stringMatching(/-cast-xyz-A\.md$/),
    ]);
    expect(result.skipped).toContain('B');
    expect(writer.captured).toHaveLength(1);
  });

  it('is idempotent: skips a clone whose post-mortem already exists on disk', async () => {
    const ctx = await makeCtx();
    await register(ctx, 'A', 'cast-xyz');
    await markDead(ctx, 'A', 'done');
    const writer = inMemoryPostMortemWriter();

    // A stale file from a previous UTC day still counts (suffix match).
    const result = await ensureSelfDeathPostMortems(ctx, {
      cloneIds: ['A'],
      writer,
      thresholds: defaultThresholds,
      existingFilenames: ['2020-01-01-cast-xyz-A.md'],
    });

    expect(result.written).toEqual([]);
    expect(result.skipped).toEqual(['A']);
    expect(writer.captured).toHaveLength(0);
  });
});
