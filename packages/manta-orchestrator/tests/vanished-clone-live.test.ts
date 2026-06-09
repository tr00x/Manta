import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { findDeadClones } from '../src/death-detector';
import { defaultThresholds } from '../src/thresholds';
import { makeProbe, isProcessAlive } from '../src/parent-pid';
import { buildBusContext, type TestBusContext } from './helpers/buildBusContext';

/**
 * #M18 LIVE empirical proof — NO mocked liveness seam.
 *
 * The unit tests assert which (pid) the death-detector probes through a stubbed
 * `alive` seam. That proves the wiring but not that a REAL vanished process is
 * actually detected. This spawns a REAL long-lived child, records its REAL pid as
 * a clone's `clone_pid` with a perfectly-fresh heartbeat and a LIVE parent pid
 * (so neither the heartbeat-staleness nor the parent-pid reap could fire), then
 * kills the child and asserts the REAL `isProcessAlive` probe drives a "process
 * vanished" reap. This is the empirical guarantee #M18 is closed against the OS,
 * not just against a spy: a clone that OOMs/crashes mid-work no longer sits
 * phantom-WORKING until its (20-min FIX-mode) heartbeat window finally lapses.
 */
function spawnLongLived(): ChildProcess {
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

describe('#M18 live vanished-clone reap (real isProcessAlive, no mock)', () => {
  let ctx: TestBusContext;
  const children: ChildProcess[] = [];

  beforeEach(async () => {
    ctx = await buildBusContext();
  });
  afterEach(async () => {
    for (const c of children) {
      try {
        if (typeof c.pid === 'number') process.kill(c.pid, 'SIGKILL');
      } catch {
        /* already dead */
      }
    }
    children.length = 0;
    await ctx.cleanup();
  });

  it('reaps a WORKING clone whose REAL process vanished, while a live parent + fresh heartbeat would not', async () => {
    const child = spawnLongLived();
    children.push(child);
    const pid = child.pid as number;
    expect(isProcessAlive(pid)).toBe(true);

    // Parent pid = this test runner (genuinely alive), heartbeat advanced only 1s
    // (fresh). The ONLY thing that can betray the clone is its own dead process.
    await ctx.registry.register({
      clone_id: 'A',
      mode: 'pair-programming',
      parent_pid: process.pid,
      worktree: '/w',
      metadata: { role: 'writer' },
    });
    await ctx.registry.recordClonePid('A', pid);
    await ctx.registry.heartbeat({ clone_id: 'A', state: 'WORKING' });
    ctx.clock.advance(1_000);

    // Process still alive → no reap (real probe).
    const alive = await findDeadClones(ctx, { thresholds: defaultThresholds, probe: makeProbe() });
    expect(alive).toEqual([]);

    // Kill the REAL process and wait for the OS to reap it.
    process.kill(pid, 'SIGKILL');
    expect(await diedWithin(pid)).toBe(true);

    // Now the real isProcessAlive probe sees it gone → "process vanished" reap.
    const dead = await findDeadClones(ctx, { thresholds: defaultThresholds, probe: makeProbe() });
    expect(dead).toHaveLength(1);
    expect(dead[0]!.clone_id).toBe('A');
    expect(dead[0]!.reason).toMatch(/process vanished/);
    expect(dead[0]!.reason).toMatch(new RegExp(`clone pid ${pid}`));
    expect(dead[0]!.reason).not.toMatch(/parent/); // parent (this runner) is alive
    expect(dead[0]!.reason).not.toMatch(/heartbeat/); // heartbeat was fresh
  });
});
