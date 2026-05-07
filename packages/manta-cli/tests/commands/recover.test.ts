import { describe, it, expect, afterEach } from 'vitest';
import { runRecoverCommand } from '../../src/commands/recover.js';
import { createReporter, MemorySink } from '../../src/output/reporter.js';
import { createRuntime } from '../../src/runtime.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';

describe('recover command', () => {
  let fx: RepoFixture | undefined;
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  it('runs orchestrator.runCycle once and reports findings', async () => {
    fx = await makeRepoFixture();
    // Tiny heartbeat threshold so the registered clone's heartbeat is
    // immediately stale by the time we run the cycle.
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: { heartbeatTimeoutMs: 1, parentPidCheckEnabled: false },
    });
    await rt.ctx.registry.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: fx.root,
      metadata: { cast_id: 'cast-r' },
    });
    // Wait briefly so heartbeat is "stale" by the new threshold.
    await new Promise((r) => setTimeout(r, 20));
    const sink = new MemorySink();
    const result = await runRecoverCommand(rt, { reporter: createReporter({ sink }) });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('1');
    expect((await rt.ctx.registry.get('A')).state).toBe('DEAD');
    // Reporter logged a `recover` event with deadDetected=1.
    const ev = sink.lines.find((l) => l.event === 'recover');
    expect(ev?.payload.deadDetected).toBe(1);
  });

  it('returns 0 even when nothing to recover', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: { parentPidCheckEnabled: false },
    });
    const result = await runRecoverCommand(rt, {
      reporter: createReporter({ sink: new MemorySink() }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Recovery complete');
  });
});
