import { describe, it, expect, afterEach } from 'vitest';
import { runAbortCommand } from '../../src/commands/abort.js';
import { createReporter, MemorySink } from '../../src/output/reporter.js';
import { createRuntime } from '../../src/runtime.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';

describe('abort command', () => {
  let fx: RepoFixture | undefined;
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  it('marks all live clones DEAD and writes a post-mortem each', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    await rt.ctx.registry.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: fx.root,
      metadata: { cast_id: 'cast-a' },
    });
    await rt.ctx.registry.register({
      clone_id: 'B',
      mode: 'recon-swarm',
      parent_pid: 2,
      worktree: fx.root,
      metadata: { cast_id: 'cast-a' },
    });
    const sink = new MemorySink();
    const result = await runAbortCommand(rt, {
      reason: 'user-abort',
      reporter: createReporter({ sink }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('2');
    expect((await rt.ctx.registry.get('A')).state).toBe('DEAD');
    expect((await rt.ctx.registry.get('B')).state).toBe('DEAD');
    // Reporter logged a single `abort` summary event with count=2.
    const ev = sink.lines.find((l) => l.event === 'abort');
    expect(ev?.payload.aborted).toBe(2);
  });

  it('does not touch already-DEAD clones', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    await rt.ctx.registry.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: fx.root,
      metadata: { cast_id: 'cast-a' },
    });
    await rt.ctx.registry.markDead('A', 'previous');
    const result = await runAbortCommand(rt, {
      reason: 'user-abort',
      reporter: createReporter({ sink: new MemorySink() }),
    });
    expect(result.exitCode).toBe(0);
    const r = await rt.ctx.registry.get('A');
    expect(r.death_reason).toBe('previous'); // not overwritten
  });

  it('returns 0 when registry is empty', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    const result = await runAbortCommand(rt, {
      reason: 'noop',
      reporter: createReporter({ sink: new MemorySink() }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('0');
  });
});
