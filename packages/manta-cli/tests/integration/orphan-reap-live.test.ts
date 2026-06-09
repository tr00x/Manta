import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { runRecoverCommand } from '../../src/commands/recover.js';
import { runAbortCommand } from '../../src/commands/abort.js';
import { runKillCommand } from '../../src/commands/kill.js';
import { createReporter, MemorySink } from '../../src/output/reporter.js';
import { createRuntime } from '../../src/runtime.js';
import { isProcessAlive } from '@manta/orchestrator';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';

/**
 * #65 LIVE empirical proof — NO mocked kill seam.
 *
 * The unit tests assert which (pid, signal) pairs the commands emit through a
 * stubbed seam. That proves the wiring but not that a real OS process actually
 * dies. These tests spawn a REAL long-lived child, record its REAL pid as a
 * clone's `clone_pid`, then reap it through the REAL `process.kill` path and
 * assert the process is genuinely gone. This is the empirical guarantee the
 * orphan-reap fix works against the operating system, not just against a spy.
 */
function spawnLongLived(): ChildProcess {
  // A real node process that runs until signalled. `detached` makes it its own
  // process-group leader and survive its spawner — mirroring a clone reparented
  // to init after its `manta cast` process exited (the exact #65 orphan shape).
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child;
}

async function diedWithin(pid: number, ms = 4000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

describe('#65 live OS-process reap (real process.kill, no mock)', () => {
  let fx: RepoFixture | undefined;
  const children: ChildProcess[] = [];
  afterEach(async () => {
    for (const c of children) {
      try {
        if (typeof c.pid === 'number') process.kill(c.pid, 'SIGKILL');
      } catch {
        /* already dead */
      }
    }
    children.length = 0;
    await fx?.cleanup();
    fx = undefined;
  });

  it('`manta recover` actually kills a real orphan (DEAD record + live pid)', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: { heartbeatTimeoutMs: 1, startupGraceMs: 1, parentPidCheckEnabled: false },
    });
    const child = spawnLongLived();
    children.push(child);
    const pid = child.pid as number;
    expect(isProcessAlive(pid)).toBe(true);

    await rt.ctx.registry.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: fx.root,
      metadata: { cast_id: 'c' },
    });
    await rt.ctx.registry.recordClonePid('A', pid);
    await new Promise((r) => setTimeout(r, 20)); // heartbeat goes stale → runCycle marks DEAD

    // REAL reap — no kill/sleep/isAlive seams, just a short SIGKILL grace.
    const sink = new MemorySink();
    const result = await runRecoverCommand(rt, {
      reporter: createReporter({ sink }),
      gracefulMs: 200,
    });

    expect(result.exitCode).toBe(0);
    expect((await rt.ctx.registry.get('A')).state).toBe('DEAD');
    const ev = sink.lines.find((l) => l.event === 'recover');
    expect(ev?.payload.orphanProcessesSignalled).toBe(1);
    expect(await diedWithin(pid)).toBe(true); // the REAL process is gone
  });

  it('`manta abort` actually kills a real clone via its recorded clone_pid', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    const child = spawnLongLived();
    children.push(child);
    const pid = child.pid as number;

    await rt.ctx.registry.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1, // init — refused by the safety guard, so only clone_pid reaps
      worktree: fx.root,
      metadata: { cast_id: 'c' },
    });
    await rt.ctx.registry.recordClonePid('A', pid);

    await runAbortCommand(rt, {
      reason: 'dogfood',
      reporter: createReporter({ sink: new MemorySink() }),
      gracefulMs: 200,
    });

    expect((await rt.ctx.registry.get('A')).state).toBe('DEAD');
    expect(await diedWithin(pid)).toBe(true);
  });

  it('`manta kill <id>` actually kills a real clone via its recorded clone_pid', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    const child = spawnLongLived();
    children.push(child);
    const pid = child.pid as number;

    await rt.ctx.registry.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: fx.root,
      metadata: { cast_id: 'c' },
    });
    await rt.ctx.registry.recordClonePid('A', pid);

    await runKillCommand(rt, {
      cloneId: 'A',
      reason: 'dogfood',
      reporter: createReporter({ sink: new MemorySink() }),
      gracefulMs: 200,
    });

    expect((await rt.ctx.registry.get('A')).state).toBe('DEAD');
    expect(await diedWithin(pid)).toBe(true);
  });
});
