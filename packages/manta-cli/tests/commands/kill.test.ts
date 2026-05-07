import { describe, it, expect, afterEach } from 'vitest';
import { runKillCommand } from '../../src/commands/kill.js';
import { createReporter, MemorySink } from '../../src/output/reporter.js';
import { createRuntime } from '../../src/runtime.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';

describe('kill command', () => {
  let fx: RepoFixture | undefined;
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  it('marks the clone DEAD and writes a post-mortem', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    await rt.ctx.registry.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: fx.root,
      metadata: { cast_id: 'cast-k' },
    });
    const sink = new MemorySink();
    const result = await runKillCommand(rt, {
      cloneId: 'A',
      reason: 'manual',
      reporter: createReporter({ sink }),
    });
    expect(result.exitCode).toBe(0);
    const r = await rt.ctx.registry.get('A');
    expect(r.state).toBe('DEAD');
    // Phase-0 post-mortem stamps the reason verbatim into death_reason.
    expect(r.death_reason).toContain('manual');
    // Reporter logged a `kill` event.
    expect(sink.lines.map((l) => l.event)).toContain('kill');
  });

  it('throws CliError(not_found) for unknown clone', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    await expect(
      runKillCommand(rt, {
        cloneId: 'GHOST',
        reason: 'manual',
        reporter: createReporter({ sink: new MemorySink() }),
      }),
    ).rejects.toMatchObject({ name: 'CliError', kind: 'not_found' });
  });
});
