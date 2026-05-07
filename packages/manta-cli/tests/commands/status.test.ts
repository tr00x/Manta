import { describe, it, expect, afterEach } from 'vitest';
import { runStatusCommand } from '../../src/commands/status.js';
import { createReporter, MemorySink } from '../../src/output/reporter.js';
import { createRuntime } from '../../src/runtime.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';

describe('status command', () => {
  let fx: RepoFixture | undefined;
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  it('prints "No active clones" when registry is empty', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    const sink = new MemorySink();
    const result = await runStatusCommand(rt, { reporter: createReporter({ sink }) });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No active clones');
    // Reporter logged a structured `status` event.
    expect(sink.lines.map((l) => l.event)).toContain('status');
  });

  it('lists registered clones', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    await rt.ctx.registry.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: fx.root,
      metadata: {},
    });
    const sink = new MemorySink();
    const result = await runStatusCommand(rt, { reporter: createReporter({ sink }) });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('A');
    expect(result.stdout).toContain('recon-swarm');
  });
});
