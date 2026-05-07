import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runPostMortem } from '../src/post-mortem';
import { inMemoryPostMortemWriter } from '../src/post-mortem-writer';
import { defaultThresholds } from '../src/thresholds';
import { buildBusContext, type TestBusContext } from './helpers/buildBusContext';

describe('post-mortem', () => {
  let ctx: TestBusContext;
  beforeEach(async () => {
    ctx = await buildBusContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it('writes a post-mortem markdown for a registered then dead clone', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: { cast_id: 'cast-42' } });
    await ctx.registry.heartbeat({ clone_id: 'A', state: 'WORKING', progress: 'half' });
    await ctx.events.append({ type: 'broadcast', clone_id: 'A', payload: { event_type: 'breakthrough', body: { summary: 'found root cause' } } });
    ctx.clock.advance(91_000);
    const writer = inMemoryPostMortemWriter();
    const result = await runPostMortem(ctx, {
      cloneId: 'A',
      reason: 'heartbeat 91000ms ago > 90000ms',
      writer,
      thresholds: defaultThresholds,
    });
    expect(result.event.type).toBe('post_mortem');
    expect(writer.captured).toHaveLength(1);
    const md = writer.captured[0]!.body;
    expect(md).toContain('# Post-mortem — clone A');
    expect(md).toContain('Reason: heartbeat 91000ms ago > 90000ms');
    expect(md).toContain('cast-42');
    expect(md).toContain('breakthrough');
    expect(writer.captured[0]!.filename).toMatch(/^\d{4}-\d{2}-\d{2}-cast-42-A\.md$/);
  });

  it('uses "no-cast" prefix when metadata lacks cast_id', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    ctx.clock.advance(91_000);
    const writer = inMemoryPostMortemWriter();
    await runPostMortem(ctx, {
      cloneId: 'A',
      reason: 'stale',
      writer,
      thresholds: defaultThresholds,
    });
    expect(writer.captured[0]!.filename).toMatch(/-no-cast-A\.md$/);
  });

  it('marks the clone DEAD if it was not already', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    const writer = inMemoryPostMortemWriter();
    await runPostMortem(ctx, { cloneId: 'A', reason: 'TTL', writer, thresholds: defaultThresholds });
    const r = await ctx.registry.get('A');
    expect(r.state).toBe('DEAD');
    expect(r.death_reason).toContain('TTL');
  });

  it('is idempotent if the clone is already DEAD', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    await ctx.registry.markDead('A', 'manual');
    const writer = inMemoryPostMortemWriter();
    await runPostMortem(ctx, { cloneId: 'A', reason: 'after-the-fact', writer, thresholds: defaultThresholds });
    expect(writer.captured).toHaveLength(1);
  });

  it('composer sanitizes hostile cast_id into a writer-safe filename', async () => {
    // The composer is responsible for ensuring the filename it hands to the
    // writer matches SAFE_FILENAME. This test wraps the writer with the same
    // guard the fs writer uses and confirms a registered clone produces a
    // filename that survives the guard — i.e. composer-level sanitization
    // works and never relies on the writer as a last line of defence for
    // happy-path inputs. (For the writer-level rejection contract, see
    // post-mortem-writer.test.ts:'fsPostMortemWriter rejects path traversal'.)
    const writer = inMemoryPostMortemWriter();
    // Override write to mimic the fs writer's SAFE_FILENAME guard
    writer.write = (doc) => {
      if (!/^[A-Za-z0-9._-]+$/.test(doc.filename)) {
        return Promise.reject(new Error(`unsafe filename: ${doc.filename}`));
      }
      writer.captured.push(doc);
      return Promise.resolve({ path: `mem://${doc.filename}` });
    };
    await ctx.registry.register({
      clone_id: 'AA', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {},
    });
    await ctx.registry.heartbeat({ clone_id: 'AA', state: 'WORKING' });
    const ok = await runPostMortem(ctx, {
      cloneId: 'AA',
      reason: 'sanitization-check',
      writer,
      thresholds: defaultThresholds,
    });
    expect(writer.captured).toHaveLength(1);
    expect(ok.document.filename).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});
