import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FakeClock } from '../../src/clock';
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
