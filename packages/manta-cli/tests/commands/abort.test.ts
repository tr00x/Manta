import { describe, it, expect, afterEach } from 'vitest';
import { runAbortCommand, type KillFn } from '../../src/commands/abort.js';
import { createReporter, MemorySink } from '../../src/output/reporter.js';
import { createRuntime } from '../../src/runtime.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';

/**
 * A recording kill seam + no-op sleep so the tests never send a real OS signal
 * or wait the real SIGKILL grace. `signals` captures every (pid, signal) the
 * command issued, in order.
 */
function killRecorder() {
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const kill: KillFn = (pid, signal) => {
    signals.push({ pid, signal });
  };
  return { signals, kill, sleep: async () => {}, gracefulMs: 0 };
}

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
      parent_pid: 4242,
      worktree: fx.root,
      metadata: { cast_id: 'cast-a' },
    });
    await rt.ctx.registry.register({
      clone_id: 'B',
      mode: 'recon-swarm',
      parent_pid: 4343,
      worktree: fx.root,
      metadata: { cast_id: 'cast-a' },
    });
    const sink = new MemorySink();
    const result = await runAbortCommand(rt, {
      reason: 'user-abort',
      reporter: createReporter({ sink }),
      ...killRecorder(),
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
      parent_pid: 4242,
      worktree: fx.root,
      metadata: { cast_id: 'cast-a' },
    });
    await rt.ctx.registry.markDead('A', 'previous');
    const result = await runAbortCommand(rt, {
      reason: 'user-abort',
      reporter: createReporter({ sink: new MemorySink() }),
      ...killRecorder(),
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
      ...killRecorder(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('0');
  });

  // ── H5 (bug #65 class): abort must terminate the OS process, not just markDead ──

  it('SIGTERMs then SIGKILLs each live clone process group BEFORE markDead', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    await rt.ctx.registry.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 4242,
      worktree: fx.root,
      metadata: { cast_id: 'cast-a' },
    });
    await rt.ctx.registry.register({
      clone_id: 'B',
      mode: 'recon-swarm',
      parent_pid: 4343,
      worktree: fx.root,
      metadata: { cast_id: 'cast-a' },
    });

    // Interleave the kill seam and markDead onto a single ordering log so we can
    // prove every signal precedes every state-mutation. runPostMortem calls
    // registry.markDead internally; we wrap the instance method to observe it.
    const order: string[] = [];
    const rec = killRecorder();
    const kill: KillFn = (pid, signal) => {
      rec.kill(pid, signal);
      order.push(`kill:${signal}:${pid}`);
    };
    const reg = rt.ctx.registry as unknown as {
      markDead: (...args: unknown[]) => Promise<unknown>;
    };
    const origMarkDead = reg.markDead.bind(rt.ctx.registry);
    reg.markDead = async (...args: unknown[]) => {
      order.push(`markDead:${String(args[0])}`);
      return origMarkDead(...args);
    };

    await runAbortCommand(rt, {
      reason: 'user-abort',
      reporter: createReporter({ sink: new MemorySink() }),
      kill,
      sleep: async () => {},
      gracefulMs: 0,
    });

    // Both live pids were signalled at the GROUP level (negative pid), SIGTERM
    // first then SIGKILL.
    expect(rec.signals).toEqual([
      { pid: -4242, signal: 'SIGTERM' },
      { pid: -4343, signal: 'SIGTERM' },
      { pid: -4242, signal: 'SIGKILL' },
      { pid: -4343, signal: 'SIGKILL' },
    ]);

    // Every kill happened strictly before any markDead — abort never marks a
    // clone DEAD while its process is still alive.
    const lastKill = order.map((s) => s.startsWith('kill:')).lastIndexOf(true);
    const firstMarkDead = order.findIndex((s) => s.startsWith('markDead:'));
    expect(lastKill).toBeGreaterThanOrEqual(0);
    expect(firstMarkDead).toBeGreaterThanOrEqual(0);
    expect(lastKill).toBeLessThan(firstMarkDead);

    expect((await rt.ctx.registry.get('A')).state).toBe('DEAD');
    expect((await rt.ctx.registry.get('B')).state).toBe('DEAD');
  });

  it('does not signal already-DEAD clones', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    await rt.ctx.registry.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 4242,
      worktree: fx.root,
      metadata: { cast_id: 'cast-a' },
    });
    await rt.ctx.registry.register({
      clone_id: 'B',
      mode: 'recon-swarm',
      parent_pid: 4343,
      worktree: fx.root,
      metadata: { cast_id: 'cast-a' },
    });
    await rt.ctx.registry.markDead('B', 'already-dead');

    const rec = killRecorder();
    await runAbortCommand(rt, {
      reason: 'user-abort',
      reporter: createReporter({ sink: new MemorySink() }),
      ...rec,
    });

    // Only the live clone A's group (4242) was signalled; the DEAD B (4343) was not.
    const pidsSignalled = new Set(rec.signals.map((s) => Math.abs(s.pid)));
    expect(pidsSignalled.has(4242)).toBe(true);
    expect(pidsSignalled.has(4343)).toBe(false);
  });

  it('refuses to signal unsafe pids (self, init) — never kills the abort process', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    // A clone whose recorded parent_pid is THIS process (a reused/stale pid) and
    // one that is init: signalling either would be catastrophic.
    await rt.ctx.registry.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: process.pid,
      worktree: fx.root,
      metadata: { cast_id: 'cast-a' },
    });
    await rt.ctx.registry.register({
      clone_id: 'B',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: fx.root,
      metadata: { cast_id: 'cast-a' },
    });

    const rec = killRecorder();
    const result = await runAbortCommand(rt, {
      reason: 'user-abort',
      reporter: createReporter({ sink: new MemorySink() }),
      ...rec,
    });

    expect(rec.signals).toHaveLength(0); // neither self nor init was signalled
    // …but the clones are still marked DEAD — the guard only blocks the signal.
    expect(result.exitCode).toBe(0);
    expect((await rt.ctx.registry.get('A')).state).toBe('DEAD');
    expect((await rt.ctx.registry.get('B')).state).toBe('DEAD');
  });
});
