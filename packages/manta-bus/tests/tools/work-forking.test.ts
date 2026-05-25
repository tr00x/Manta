import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FakeClock } from '../../src/clock';
import { busPaths } from '../../src/state/paths';
import { EventsLog } from '../../src/state/events';
import { Registry } from '../../src/state/registry';
import { ClaimsStore } from '../../src/state/claims';
import { makeTmpRoot } from '../helpers/tmpRoot';
import { createWorkHandlers } from '../../src/tools/work';

describe('manta.claim_work under forking-realities', () => {
  let root: string;
  let cleanup: () => Promise<void>;
  let clock: FakeClock;
  let registry: Registry;
  let handlers: ReturnType<typeof createWorkHandlers>;

  beforeEach(async () => {
    ({ root, cleanup } = await makeTmpRoot());
    clock = new FakeClock(1_000_000);
    const paths = busPaths(root);
    registry = new Registry(paths, clock);
    handlers = createWorkHandlers({
      events: new EventsLog(paths, clock),
      registry,
      claims: new ClaimsStore(paths, clock),
    });
  });
  afterEach(async () => {
    await cleanup();
  });

  it('rejects FR clone with forking_isolation error', async () => {
    await registry.register({
      clone_id: 'A',
      mode: 'forking-realities',
      parent_pid: 1,
      worktree: '/tmp/A',
      metadata: { cast_id: 'cast-1', cast_mode: 'forking-realities' },
    });
    await expect(
      handlers.claim({ clone_id: 'A', item: 'task-1', timeout_ms: 60_000 }),
    ).rejects.toMatchObject({
      name: 'BusForkingIsolationError',
      tool: 'manta.claim_work',
      fromCloneId: 'A',
      castId: 'cast-1',
    });
  });

  it('allows recon-swarm clone (regression guard)', async () => {
    await registry.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: '/tmp/A',
      metadata: { cast_id: 'cast-1', cast_mode: 'recon-swarm' },
    });
    const r = await handlers.claim({ clone_id: 'A', item: 'task-1', timeout_ms: 60_000 });
    expect(r.claim.item).toBe('task-1');
  });

  it('release_work for FR clone falls through to existing semantics (no-op)', async () => {
    await registry.register({
      clone_id: 'A',
      mode: 'forking-realities',
      parent_pid: 1,
      worktree: '/tmp/A',
      metadata: { cast_id: 'cast-1', cast_mode: 'forking-realities' },
    });
    // ClaimsStore.release on a non-existent claim is a no-op (returns current).
    // Phase 2b does NOT block release_work for FR clones — the FR clone never
    // claimed in the first place, so release is a no-op edge case.
    const r = await handlers.release({ clone_id: 'A', item: 'task-1' });
    expect(r.event.type).toBe('release');
  });
});
