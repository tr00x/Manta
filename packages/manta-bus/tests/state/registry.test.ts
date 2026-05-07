import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fork } from 'node:child_process';
import * as path from 'node:path';
import { FakeClock, systemClock } from '../../src/clock';
import { busPaths } from '../../src/state/paths';
import { Registry } from '../../src/state/registry';
import { makeTmpRoot } from '../helpers/tmpRoot';
import { BusNotFoundError, BusConflictError } from '../../src/errors';

describe('Registry', () => {
  let root: string;
  let cleanup: () => Promise<void>;
  let clock: FakeClock;
  let registry: Registry;

  beforeEach(async () => {
    ({ root, cleanup } = await makeTmpRoot());
    clock = new FakeClock(1_000_000);
    registry = new Registry(busPaths(root), clock);
  });
  afterEach(async () => {
    await cleanup();
  });

  it('register stores a clone record', async () => {
    await registry.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1234,
      worktree: '/tmp/w',
      metadata: {},
    });
    const r = await registry.get('A');
    expect(r.clone_id).toBe('A');
    expect(r.mode).toBe('recon-swarm');
    expect(r.last_heartbeat_at).toBe(1_000_000);
    expect(r.state).toBe('STARTING');
  });

  it('register twice for same clone_id is a conflict', async () => {
    await registry.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1234,
      worktree: '/tmp/w',
      metadata: {},
    });
    await expect(
      registry.register({
        clone_id: 'A',
        mode: 'recon-swarm',
        parent_pid: 4321,
        worktree: '/tmp/w2',
        metadata: {},
      }),
    ).rejects.toBeInstanceOf(BusConflictError);
  });

  it('heartbeat updates last_heartbeat_at and state', async () => {
    await registry.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: '/tmp/w',
      metadata: {},
    });
    clock.advance(7_500);
    await registry.heartbeat({ clone_id: 'A', state: 'WORKING', progress: 'mid' });
    const r = await registry.get('A');
    expect(r.last_heartbeat_at).toBe(1_007_500);
    expect(r.state).toBe('WORKING');
    expect(r.progress).toBe('mid');
  });

  it('heartbeat for unknown clone is a not-found error', async () => {
    await expect(
      registry.heartbeat({ clone_id: 'GHOST', state: 'WORKING' }),
    ).rejects.toBeInstanceOf(BusNotFoundError);
  });

  it('heartbeat refuses DEAD transition (markDead is the only path)', async () => {
    await registry.register({
      clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {},
    });
    await expect(
      registry.heartbeat({ clone_id: 'A', state: 'DEAD' }),
    ).rejects.toBeInstanceOf(BusConflictError);
  });

  it('heartbeat from a DEAD clone is rejected (no zombie resurrection)', async () => {
    // Regression test for Fix #11: a clone marked DEAD must not be able to
    // resurrect itself by sending a non-DEAD heartbeat.
    await registry.register({
      clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {},
    });
    await registry.markDead('A', 'rip');
    await expect(
      registry.heartbeat({ clone_id: 'A', state: 'WORKING' }),
    ).rejects.toBeInstanceOf(BusConflictError);
    const r = await registry.get('A');
    expect(r.state).toBe('DEAD');
  });

  it('touch updates last_heartbeat_at on a WORKING clone without changing state', async () => {
    // Bug #9 structural fix (option d): any successful MCP call from a
    // registered clone updates last_heartbeat_at as a side effect; explicit
    // manta.heartbeat keeps its role for state transitions.
    await registry.register({
      clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {},
    });
    await registry.heartbeat({ clone_id: 'A', state: 'WORKING' });
    const before = await registry.get('A');
    expect(before.state).toBe('WORKING');
    expect(before.last_heartbeat_at).toBe(1_000_000);

    clock.advance(45_000);
    await registry.touch('A');

    const after = await registry.get('A');
    expect(after.last_heartbeat_at).toBe(1_045_000);
    expect(after.state).toBe('WORKING'); // touch never changes state
  });

  it('touch is a silent no-op on a DEAD clone (death is terminal)', async () => {
    // No zombie resurrection — once DEAD, even side-effect liveness updates
    // are ignored so post-mortems and sibling references stay consistent.
    await registry.register({
      clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {},
    });
    await registry.markDead('A', 'rip');
    const before = await registry.get('A');
    const heartbeatBefore = before.last_heartbeat_at;

    clock.advance(60_000);
    await expect(registry.touch('A')).resolves.toBeUndefined();

    const after = await registry.get('A');
    expect(after.state).toBe('DEAD');
    expect(after.last_heartbeat_at).toBe(heartbeatBefore); // unchanged
  });

  it('touch is a silent no-op on an unknown clone (no throw)', async () => {
    // Main-side calls or typos must not crash the dispatcher. The contract
    // is "best-effort liveness side-effect", not "strict id check".
    await expect(registry.touch('GHOST')).resolves.toBeUndefined();
    await expect(registry.list()).resolves.toEqual([]);
  });

  it('list returns all registered clones', async () => {
    await registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    await registry.register({ clone_id: 'B', mode: 'recon-swarm', parent_pid: 2, worktree: '/w', metadata: {} });
    const all = await registry.list();
    expect(all.map((r) => r.clone_id).sort()).toEqual(['A', 'B']);
  });

  it('markDead transitions state and records death reason', async () => {
    await registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    clock.advance(5_000);
    await registry.markDead('A', 'self-terminated: drift > 30%');
    const r = await registry.get('A');
    expect(r.state).toBe('DEAD');
    expect(r.death_reason).toBe('self-terminated: drift > 30%');
    expect(r.died_at).toBe(1_005_000);
  });

  it('markDead for unknown clone is a not-found error', async () => {
    await expect(registry.markDead('GHOST', 'why')).rejects.toBeInstanceOf(BusNotFoundError);
  });

  it('staleSince returns clones whose heartbeat is older than threshold', async () => {
    await registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    clock.advance(5_000);
    await registry.register({ clone_id: 'B', mode: 'recon-swarm', parent_pid: 2, worktree: '/w', metadata: {} });
    // A is older by 5_000 ms; threshold of 4_000 should pick up A only.
    clock.advance(0);
    const stale = await registry.staleSince(4_000);
    expect(stale.map((r) => r.clone_id)).toEqual(['A']);
  });

  it('does not return DEAD clones from staleSince', async () => {
    await registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    await registry.markDead('A', 'rip');
    clock.advance(60_000);
    const stale = await registry.staleSince(1_000);
    expect(stale).toEqual([]);
  });
});

describe('Registry — cross-process safety', () => {
  // Fix #13: in-process Promise.all does NOT exercise the same proper-lockfile
  // code path as two separate Node processes (different pids, real watch/poll
  // retry behaviour). This test forks two workers that each register clones
  // via the public Registry API against the same state.json and asserts no
  // losses, no corruption.
  it('two forked processes registering N clones each lose nothing', async () => {
    const { root, cleanup } = await makeTmpRoot();
    try {
      const workerScript = path.join(__dirname, '..', 'helpers', 'registryHammerWorker.ts');
      const COUNT_PER_WORKER = 25;

      const runWorker = (workerId: string): Promise<string[]> =>
        new Promise((resolve, reject) => {
          const child = fork(
            workerScript,
            [root, workerId, String(COUNT_PER_WORKER)],
            { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
          );
          let result: { ok: boolean; registered?: string[]; error?: string } | null = null;
          child.on('message', (m) => {
            result = m as typeof result;
          });
          child.on('error', reject);
          child.on('exit', (code) => {
            if (code !== 0 || !result || !result.ok) {
              reject(new Error(`worker ${workerId} failed: ${result?.error ?? `exit ${code}`}`));
              return;
            }
            resolve(result.registered ?? []);
          });
        });

      const [a, b] = await Promise.all([runWorker('w1'), runWorker('w2')]);
      const expected = new Set([...a, ...b]);
      expect(expected.size).toBe(2 * COUNT_PER_WORKER);

      const registry = new Registry(busPaths(root), systemClock);
      const all = await registry.list();
      const seen = new Set(all.map((r) => r.clone_id));
      // Strict equality: every expected id present, no extras.
      expect(seen.size).toBe(expected.size);
      for (const id of expected) expect(seen.has(id)).toBe(true);
    } finally {
      await cleanup();
    }
  }, 15_000);
});
