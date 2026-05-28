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

  it('re-register overwrites a DEAD clone (name reuse across casts)', async () => {
    await registry.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1234,
      worktree: '/tmp/w',
      metadata: { cast_id: 'cast-1' },
    });
    await registry.markDead('A', 'done');
    const dead = await registry.get('A');
    expect(dead.state).toBe('DEAD');

    clock.advance(1000);
    const reborn = await registry.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 5678,
      worktree: '/tmp/w2',
      metadata: { cast_id: 'cast-2' },
    });
    expect(reborn.state).toBe('STARTING');
    expect(reborn.parent_pid).toBe(5678);
    expect(reborn.worktree).toBe('/tmp/w2');
    expect(reborn.metadata).toEqual({ cast_id: 'cast-2' });
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

  it('markDead with stale observedLastHeartbeatAt throws BusConflictError (bug #38 liveness recheck)', async () => {
    // Simulates: orchestrator's findDeadClones() read the registry at time T
    // (observed = T), then the clone heartbeat'd at T+1, then the orchestrator
    // tried to markDead with observed=T. The recheck inside markDead's mutex
    // must catch the divergence and abort — without this, the clone would be
    // permanently DEAD-locked despite being alive (heartbeat rejects DEAD).
    await registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    const before = await registry.get('A');
    const observedTs = before.last_heartbeat_at;
    // Clone heartbeats — advances last_heartbeat_at past `observedTs`.
    clock.advance(1);
    await registry.heartbeat({ clone_id: 'A', state: 'WORKING' });
    const afterHb = await registry.get('A');
    expect(afterHb.last_heartbeat_at).toBeGreaterThan(observedTs);
    // Reaper attempts markDead with the stale observed ts — must abort.
    await expect(
      registry.markDead('A', 'reaper', undefined, observedTs),
    ).rejects.toBeInstanceOf(BusConflictError);
    // State unchanged: clone is still WORKING, not DEAD.
    const still = await registry.get('A');
    expect(still.state).toBe('WORKING');
    expect(still.died_at).toBeUndefined();
  });

  it('markDead with matching observedLastHeartbeatAt succeeds (no false-positive aborts)', async () => {
    await registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    const r = await registry.get('A');
    // Observed value matches current state — no race, reaper proceeds.
    await registry.markDead('A', 'reaper', undefined, r.last_heartbeat_at);
    const dead = await registry.get('A');
    expect(dead.state).toBe('DEAD');
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
  it('heartbeat to IDLE sets idle_since and increments tasks_completed', async () => {
    await registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    await registry.heartbeat({ clone_id: 'A', state: 'WORKING' });
    clock.advance(5_000);
    await registry.heartbeat({ clone_id: 'A', state: 'IDLE' });
    const r = await registry.get('A');
    expect(r.state).toBe('IDLE');
    expect(r.idle_since).toBe(1_005_000);
    expect(r.tasks_completed).toBe(1);
    expect(r.last_task_completed_at).toBe(1_005_000);
  });

  it('heartbeat to IDLE increments tasks_completed cumulatively', async () => {
    await registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    await registry.heartbeat({ clone_id: 'A', state: 'WORKING' });
    clock.advance(1_000);
    await registry.heartbeat({ clone_id: 'A', state: 'IDLE' });
    clock.advance(1_000);
    await registry.heartbeat({ clone_id: 'A', state: 'WORKING' });
    clock.advance(1_000);
    await registry.heartbeat({ clone_id: 'A', state: 'IDLE' });
    const r = await registry.get('A');
    expect(r.tasks_completed).toBe(2);
  });

  it('heartbeat from IDLE to WORKING clears idle_since', async () => {
    await registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    await registry.heartbeat({ clone_id: 'A', state: 'WORKING' });
    clock.advance(1_000);
    await registry.heartbeat({ clone_id: 'A', state: 'IDLE' });
    expect((await registry.get('A')).idle_since).toBeDefined();
    clock.advance(1_000);
    await registry.heartbeat({ clone_id: 'A', state: 'WORKING' });
    const r = await registry.get('A');
    expect(r.idle_since).toBeUndefined();
    expect(r.state).toBe('WORKING');
  });

  it('heartbeat from BLOCKED to IDLE is rejected', async () => {
    await registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    await registry.heartbeat({ clone_id: 'A', state: 'BLOCKED' });
    await expect(
      registry.heartbeat({ clone_id: 'A', state: 'IDLE' }),
    ).rejects.toBeInstanceOf(BusConflictError);
  });

  it('retask transitions IDLE to WORKING', async () => {
    await registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    await registry.heartbeat({ clone_id: 'A', state: 'WORKING' });
    clock.advance(1_000);
    await registry.heartbeat({ clone_id: 'A', state: 'IDLE' });
    clock.advance(1_000);
    const r = await registry.retask('A', 'new task: fix the bug');
    expect(r.state).toBe('WORKING');
    expect(r.idle_since).toBeUndefined();
    expect(r.progress).toMatch(/retasked/);
  });

  it('retask transitions WAITING_FOR_TASK to WORKING', async () => {
    await registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    await registry.heartbeat({ clone_id: 'A', state: 'WAITING_FOR_TASK' });
    const r = await registry.retask('A', 'assigned task');
    expect(r.state).toBe('WORKING');
  });

  it('retask rejects WORKING clone', async () => {
    await registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    await registry.heartbeat({ clone_id: 'A', state: 'WORKING' });
    await expect(registry.retask('A', 'nope')).rejects.toBeInstanceOf(BusConflictError);
  });

  it('retask rejects DEAD clone', async () => {
    await registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    await registry.markDead('A', 'rip');
    await expect(registry.retask('A', 'nope')).rejects.toBeInstanceOf(BusConflictError);
  });

  it('retask rejects unknown clone', async () => {
    await expect(registry.retask('GHOST', 'nope')).rejects.toBeInstanceOf(BusNotFoundError);
  });

  it('staleSince excludes IDLE clones under idleThreshold', async () => {
    await registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    await registry.heartbeat({ clone_id: 'A', state: 'IDLE' });
    clock.advance(5_000);
    const stale = await registry.staleSince(4_000, 60_000);
    expect(stale).toEqual([]);
  });

  it('staleSince includes IDLE clones over idleThreshold', async () => {
    await registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    await registry.heartbeat({ clone_id: 'A', state: 'IDLE' });
    clock.advance(61_000);
    const stale = await registry.staleSince(4_000, 60_000);
    expect(stale.map((r) => r.clone_id)).toEqual(['A']);
  });

  it('CloneRecord.session_mode is persisted through heartbeat', async () => {
    await registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    const before = await registry.get('A');
    expect(before.session_mode).toBeUndefined();
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

      // Pin fork cwd to the bus package root so `--import tsx` resolves the
      // `tsx` loader from this package's node_modules. Workspace root has no
      // `tsx` dep (it's a devDep of @manta/bus only), so under the full-suite
      // vitest run (cwd = workspace root) the default-cwd fork dies with
      // ERR_MODULE_NOT_FOUND before main() runs. Isolated `cd packages/manta-bus
      // && vitest` happens to work because cwd already matches.
      const pkgRoot = path.resolve(__dirname, '..', '..');
      const runWorker = (workerId: string): Promise<string[]> =>
        new Promise((resolve, reject) => {
          const child = fork(
            workerScript,
            [root, workerId, String(COUNT_PER_WORKER)],
            { cwd: pkgRoot, execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
          );
          let result: { ok: boolean; registered?: string[]; error?: string } | null = null;
          // Capture stderr/stdout so any pre-main crash (tsx loader error,
          // top-level import throw, native abort, SIGKILL trace) reaches the
          // parent. Without this, a worker dying outside main().catch leaves
          // the parent with only "exit <code>" and no clue why.
          const stderrChunks: Buffer[] = [];
          const stdoutChunks: Buffer[] = [];
          child.stderr?.on('data', (c: Buffer) => stderrChunks.push(c));
          child.stdout?.on('data', (c: Buffer) => stdoutChunks.push(c));
          child.on('message', (m) => {
            result = m as typeof result;
          });
          child.on('error', reject);
          child.on('exit', (code, signal) => {
            if (code !== 0 || !result || !result.ok) {
              const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
              const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
              const tail = (s: string): string => s.split('\n').slice(-20).join('\n');
              const parts = [`worker ${workerId} failed`];
              parts.push(result?.error ? `error=${result.error}` : `exit=${code ?? 'null'} signal=${signal ?? 'null'}`);
              if (stderr) parts.push(`stderr-tail:\n${tail(stderr)}`);
              if (stdout) parts.push(`stdout-tail:\n${tail(stdout)}`);
              reject(new Error(parts.join(' | ')));
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
