import { describe, it, expect, afterEach } from 'vitest';
import { runReplayCommand } from '../../src/commands/replay.js';
import { createRuntime } from '../../src/runtime.js';
import { createReporter, MemorySink } from '../../src/output/reporter.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';
import { CliError } from '../../src/errors.js';

describe('replay command', () => {
  let fx: RepoFixture | undefined;
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  const sink = (): { sink: MemorySink; reporter: ReturnType<typeof createReporter> } => {
    const s = new MemorySink();
    return { sink: s, reporter: createReporter({ sink: s }) };
  };

  async function seedCast(rt: Awaited<ReturnType<typeof createRuntime>>, castId: string): Promise<void> {
    await rt.ctx.casts.create({
      cast_id: castId,
      mode: 'recon-swarm',
      clones: [{ clone_id: 'A', assignment: null }],
      policy: { peer_messaging: 'allowed', auto_merge_threshold: null, session_mode: 'batch' },
    });
    await rt.ctx.registry.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: '/tmp/wt',
      metadata: { cast_id: castId },
    });
    await rt.ctx.events.append({ type: 'register', clone_id: 'A', payload: {} });
    await rt.ctx.events.append({ type: 'heartbeat', clone_id: 'A', payload: { state: 'WORKING' } });
    await rt.ctx.events.append({ type: 'broadcast', clone_id: 'A', payload: { msg: 'hello' } });
  }

  it('returns markdown replay for a valid castId', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    await seedCast(rt, 'cast-100');
    const { reporter } = sink();
    const result = await runReplayCommand(rt, {
      castId: 'cast-100',
      format: 'markdown',
      reporter,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Cast Replay: cast-100');
    expect(result.stdout).toContain('recon-swarm');
  });

  it('returns valid JSON with --format json', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    await seedCast(rt, 'cast-200');
    const { reporter } = sink();
    const result = await runReplayCommand(rt, {
      castId: 'cast-200',
      format: 'json',
      reporter,
    });
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed).toHaveProperty('castId', 'cast-200');
    expect(parsed).toHaveProperty('events');
    expect(parsed).toHaveProperty('cloneSummaries');
  });

  it('filters by clone', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    await rt.ctx.casts.create({
      cast_id: 'cast-300',
      mode: 'recon-swarm',
      clones: [
        { clone_id: 'A', assignment: null },
        { clone_id: 'B', assignment: null },
      ],
      policy: { peer_messaging: 'allowed', auto_merge_threshold: null, session_mode: 'batch' },
    });
    await rt.ctx.registry.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: '/tmp/wt-a',
      metadata: { cast_id: 'cast-300' },
    });
    await rt.ctx.registry.register({
      clone_id: 'B',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: '/tmp/wt-b',
      metadata: { cast_id: 'cast-300' },
    });
    await rt.ctx.events.append({ type: 'heartbeat', clone_id: 'A', payload: { state: 'WORKING' } });
    await rt.ctx.events.append({ type: 'heartbeat', clone_id: 'B', payload: { state: 'WORKING' } });
    const { reporter } = sink();
    const result = await runReplayCommand(rt, {
      castId: 'cast-300',
      format: 'json',
      cloneIds: ['A'],
      reporter,
    });
    const parsed = JSON.parse(result.stdout) as { events: Array<{ event: { clone_id?: string } }> };
    for (const ev of parsed.events) {
      if (ev.event.clone_id != null) {
        expect(ev.event.clone_id).toBe('A');
      }
    }
  });

  it('filters by --since', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    await seedCast(rt, 'cast-400');
    const { reporter } = sink();
    const result = await runReplayCommand(rt, {
      castId: 'cast-400',
      format: 'json',
      since: Date.now() + 999_999,
      reporter,
    });
    const parsed = JSON.parse(result.stdout) as { events: unknown[] };
    expect(parsed.events.length).toBe(0);
  });

  it('throws CliError not_found for missing castId', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    const { reporter } = sink();
    await expect(
      runReplayCommand(rt, { castId: 'nonexistent', format: 'markdown', reporter }),
    ).rejects.toThrow(CliError);
    try {
      await runReplayCommand(rt, { castId: 'nonexistent', format: 'markdown', reporter });
    } catch (err) {
      expect((err as CliError).kind).toBe('not_found');
    }
  });
});
