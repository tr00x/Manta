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
      thresholdOverrides: { heartbeatTimeoutMs: 1, startupGraceMs: 1, parentPidCheckEnabled: false },
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

  it("SIGTERM→SIGKILLs a DEAD clone whose OWN process is still alive — an orphan (#65)", async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: { heartbeatTimeoutMs: 1, startupGraceMs: 1, parentPidCheckEnabled: false },
    });
    await rt.ctx.registry.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: fx.root,
      metadata: { cast_id: 'cast-r' },
    });
    await rt.ctx.registry.recordClonePid('A', 9001);
    await new Promise((r) => setTimeout(r, 20)); // heartbeat goes stale → runCycle marks DEAD

    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const sink = new MemorySink();
    const result = await runRecoverCommand(rt, {
      reporter: createReporter({ sink }),
      kill: (pid: number, signal: NodeJS.Signals) => signals.push({ pid, signal }),
      isAlive: (pid: number) => pid === 9001, // the orphan `claude` is still running
      sleep: async () => {},
      gracefulMs: 0,
    });

    expect((await rt.ctx.registry.get('A')).state).toBe('DEAD');
    // The orphan's OWN pid 9001 (bare) was SIGTERM'd then SIGKILL'd.
    expect(signals).toEqual([
      { pid: 9001, signal: 'SIGTERM' },
      { pid: 9001, signal: 'SIGKILL' },
    ]);
    const ev = sink.lines.find((l) => l.event === 'recover');
    expect(ev?.payload.orphanProcessesSignalled).toBe(1);
    expect(result.stdout).toContain('orphan process');
  });

  it('reaps an orphan whose pid was recorded AFTER it was marked DEAD (#65-2 race)', async () => {
    // The reaper can mark a clone DEAD in the window between register and the
    // spawner's recordClonePid. recordClonePid must still persist the pid (it
    // does not revive the clone), or the orphan becomes unreachable.
    fx = await makeRepoFixture();
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: { parentPidCheckEnabled: false },
    });
    await rt.ctx.registry.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: fx.root,
      metadata: { cast_id: 'cast-r' },
    });
    await rt.ctx.registry.markDead('A', 'reaped mid-spawn');
    await rt.ctx.registry.recordClonePid('A', 9001); // spawner lands the pid AFTER DEAD
    expect((await rt.ctx.registry.get('A')).clone_pid).toBe(9001);

    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    await runRecoverCommand(rt, {
      reporter: createReporter({ sink: new MemorySink() }),
      kill: (pid: number, signal: NodeJS.Signals) => signals.push({ pid, signal }),
      isAlive: (pid: number) => pid === 9001,
      sleep: async () => {},
      gracefulMs: 0,
    });
    // The orphan (DEAD + live pid recorded post-mortem) is still reachable.
    expect(signals).toEqual([
      { pid: 9001, signal: 'SIGTERM' },
      { pid: 9001, signal: 'SIGKILL' },
    ]);
  });

  it('does not signal a DEAD clone whose process is already gone', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: { heartbeatTimeoutMs: 1, startupGraceMs: 1, parentPidCheckEnabled: false },
    });
    await rt.ctx.registry.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: fx.root,
      metadata: { cast_id: 'cast-r' },
    });
    await rt.ctx.registry.recordClonePid('A', 9001);
    await new Promise((r) => setTimeout(r, 20));

    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const result = await runRecoverCommand(rt, {
      reporter: createReporter({ sink: new MemorySink() }),
      kill: (pid: number, signal: NodeJS.Signals) => signals.push({ pid, signal }),
      isAlive: () => false, // process already gone
      sleep: async () => {},
      gracefulMs: 0,
    });
    expect(signals).toHaveLength(0);
    expect(result.exitCode).toBe(0);
  });
});
