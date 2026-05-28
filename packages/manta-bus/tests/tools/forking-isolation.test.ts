import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FakeClock } from '../../src/clock';
import { busPaths } from '../../src/state/paths';
import { Registry } from '../../src/state/registry';
import { LocksStore } from '../../src/state/locks';
import { EventsLog } from '../../src/state/events';
import { makeTmpRoot } from '../helpers/tmpRoot';
import { RegisterInputSchema } from '../../src/schema';
import { BusForkingIsolationError } from '../../src/errors';
import { siblingsInSameForkingCast, crossCloneRead } from '../../src/tools/forking-isolation';
import { createLockHandlers } from '../../src/tools/locks';
import { atomicMutateJson } from '../../src/atomic-fs';

describe('RegisterInputSchema (forking-realities invariants)', () => {
  it('accepts a recon-swarm register without metadata.cast_id', () => {
    expect(() =>
      RegisterInputSchema.parse({
        clone_id: 'A',
        mode: 'recon-swarm',
        parent_pid: 1234,
        worktree: '/tmp/wt-A',
      }),
    ).not.toThrow();
  });

  it('rejects a forking-realities register without metadata.cast_id', () => {
    expect(() =>
      RegisterInputSchema.parse({
        clone_id: 'A',
        mode: 'forking-realities',
        parent_pid: 1234,
        worktree: '/tmp/wt-A',
        metadata: {},
      }),
    ).toThrow(/cast_id/);
  });

  it('rejects forking-realities register with malformed cast_id', () => {
    expect(() =>
      RegisterInputSchema.parse({
        clone_id: 'A',
        mode: 'forking-realities',
        parent_pid: 1234,
        worktree: '/tmp/wt-A',
        metadata: { cast_id: 'cast/../escape' },
      }),
    ).toThrow();
  });

  it('accepts forking-realities register with valid metadata.cast_id', () => {
    expect(() =>
      RegisterInputSchema.parse({
        clone_id: 'A',
        mode: 'forking-realities',
        parent_pid: 1234,
        worktree: '/tmp/wt-A',
        metadata: { cast_id: 'cast-1700000000000', cast_mode: 'forking-realities' },
      }),
    ).not.toThrow();
  });
});

describe('BusForkingIsolationError', () => {
  it('captures from/to/cast/tool fields', () => {
    const err = new BusForkingIsolationError({
      tool: 'manta.message',
      fromCloneId: 'A',
      toCloneId: 'B',
      castId: 'cast-1',
    });
    expect(err.name).toBe('BusForkingIsolationError');
    expect(err.tool).toBe('manta.message');
    expect(err.fromCloneId).toBe('A');
    expect(err.toCloneId).toBe('B');
    expect(err.castId).toBe('cast-1');
    expect(err.message).toMatch(/forking-realities/);
    expect(err.message).toMatch(/A.*B/);
  });

  it('omits toCloneId when not provided', () => {
    const err = new BusForkingIsolationError({
      tool: 'manta.claim_work',
      fromCloneId: 'A',
      castId: 'cast-1',
    });
    expect(err.toCloneId).toBeUndefined();
    expect(err.message).not.toContain('→');
  });
});

describe('siblingsInSameForkingCast', () => {
  let root: string;
  let cleanup: () => Promise<void>;
  let registry: Registry;

  beforeEach(async () => {
    ({ root, cleanup } = await makeTmpRoot());
    registry = new Registry(busPaths(root), new FakeClock(1_700_000_000_000));
  });
  afterEach(async () => {
    await cleanup();
  });

  it('returns same:true for two FR siblings of the same cast', async () => {
    await registry.register({
      clone_id: 'A',
      mode: 'forking-realities',
      parent_pid: 1,
      worktree: '/tmp/A',
      metadata: { cast_id: 'cast-1', cast_mode: 'forking-realities' },
    });
    await registry.register({
      clone_id: 'B',
      mode: 'forking-realities',
      parent_pid: 1,
      worktree: '/tmp/B',
      metadata: { cast_id: 'cast-1', cast_mode: 'forking-realities' },
    });
    const result = await siblingsInSameForkingCast({ registry }, 'A', 'B');
    expect(result.same).toBe(true);
    if (result.same) expect(result.castId).toBe('cast-1');
  });

  it('returns same:false for two recon-swarm clones', async () => {
    await registry.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: '/tmp/A',
      metadata: { cast_id: 'cast-1', cast_mode: 'recon-swarm' },
    });
    await registry.register({
      clone_id: 'B',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: '/tmp/B',
      metadata: { cast_id: 'cast-1', cast_mode: 'recon-swarm' },
    });
    const result = await siblingsInSameForkingCast({ registry }, 'A', 'B');
    expect(result.same).toBe(false);
  });

  it('returns same:false for FR clones across different casts', async () => {
    await registry.register({
      clone_id: 'A',
      mode: 'forking-realities',
      parent_pid: 1,
      worktree: '/tmp/A',
      metadata: { cast_id: 'cast-1', cast_mode: 'forking-realities' },
    });
    await registry.register({
      clone_id: 'B',
      mode: 'forking-realities',
      parent_pid: 1,
      worktree: '/tmp/B',
      metadata: { cast_id: 'cast-2', cast_mode: 'forking-realities' },
    });
    const result = await siblingsInSameForkingCast({ registry }, 'A', 'B');
    expect(result.same).toBe(false);
  });

  it('returns same:false for self (A === A)', async () => {
    const result = await siblingsInSameForkingCast({ registry }, 'A', 'A');
    expect(result.same).toBe(false);
  });
});

describe('crossCloneRead', () => {
  let root: string;
  let cleanup: () => Promise<void>;
  let registry: Registry;

  beforeEach(async () => {
    ({ root, cleanup } = await makeTmpRoot());
    registry = new Registry(busPaths(root), new FakeClock(1_700_000_000_000));
  });
  afterEach(async () => {
    await cleanup();
  });

  it('blocks FR clone reading another clone_id', async () => {
    await registry.register({
      clone_id: 'A',
      mode: 'forking-realities',
      parent_pid: 1,
      worktree: '/tmp/A',
      metadata: { cast_id: 'cast-1', cast_mode: 'forking-realities' },
    });
    const result = await crossCloneRead({ registry }, 'A', 'B');
    expect(result.blocked).toBe(true);
    if (result.blocked) expect(result.castId).toBe('cast-1');
  });

  it('allows FR clone reading own clone_id', async () => {
    await registry.register({
      clone_id: 'A',
      mode: 'forking-realities',
      parent_pid: 1,
      worktree: '/tmp/A',
      metadata: { cast_id: 'cast-1', cast_mode: 'forking-realities' },
    });
    const result = await crossCloneRead({ registry }, 'A', 'A');
    expect(result.blocked).toBe(false);
  });

  it('allows recon-swarm clone reading any clone_id', async () => {
    await registry.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: '/tmp/A',
      metadata: { cast_id: 'cast-1', cast_mode: 'recon-swarm' },
    });
    const result = await crossCloneRead({ registry }, 'A', 'B');
    expect(result.blocked).toBe(false);
  });

  it('allows unknown caller (not in registry)', async () => {
    const result = await crossCloneRead({ registry }, 'UNKNOWN', 'B');
    expect(result.blocked).toBe(false);
  });
});

describe('manta.lock / unlock / renew_lock under forking-realities (bug #28)', () => {
  // Bug #28: FR-cast clones share no resources (each has its own worktree),
  // so the shared `.manta/state/locks.json` collision between two siblings
  // is structurally meaningless and was the trigger for spurious BusLocked
  // errors on identical paths in different worktrees. Symmetric to the
  // existing FR-rejection on `manta.claim_work`.
  let root: string;
  let cleanup: () => Promise<void>;
  let clock: FakeClock;
  let registry: Registry;
  let handlers: ReturnType<typeof createLockHandlers>;

  beforeEach(async () => {
    ({ root, cleanup } = await makeTmpRoot());
    clock = new FakeClock(1_000_000);
    const paths = busPaths(root);
    registry = new Registry(paths, clock);
    handlers = createLockHandlers({
      locks: new LocksStore(paths, clock, { staleAfterMs: 15_000 }),
      events: new EventsLog(paths, clock),
      registry,
    });
  });
  afterEach(async () => {
    await cleanup();
  });

  async function registerFr(cloneId: string, castId = 'cast-1'): Promise<void> {
    await registry.register({
      clone_id: cloneId,
      mode: 'forking-realities',
      parent_pid: 1,
      worktree: `/tmp/${cloneId}`,
      metadata: { cast_id: castId, cast_mode: 'forking-realities' },
    });
  }

  it('manta.lock rejects FR clone with forking_isolation error', async () => {
    await registerFr('A');
    await expect(
      handlers.lock({ clone_id: 'A', path: 'packages/foo/bar.ts' }),
    ).rejects.toMatchObject({
      name: 'BusForkingIsolationError',
      tool: 'manta.lock',
      fromCloneId: 'A',
      castId: 'cast-1',
    });
  });

  it('manta.unlock rejects FR clone with forking_isolation error', async () => {
    await registerFr('A');
    await expect(
      handlers.unlock({ clone_id: 'A', path: 'packages/foo/bar.ts' }),
    ).rejects.toMatchObject({
      name: 'BusForkingIsolationError',
      tool: 'manta.unlock',
      fromCloneId: 'A',
      castId: 'cast-1',
    });
  });

  it('manta.renew_lock rejects FR clone with forking_isolation error', async () => {
    await registerFr('A');
    await expect(
      handlers.renew({ clone_id: 'A', path: 'packages/foo/bar.ts' }),
    ).rejects.toMatchObject({
      name: 'BusForkingIsolationError',
      tool: 'manta.renew_lock',
      fromCloneId: 'A',
      castId: 'cast-1',
    });
  });

  it('FR rejection fires before lock state is touched (no leaked lease)', async () => {
    await registerFr('A');
    const locks = new LocksStore(busPaths(root), clock, { staleAfterMs: 15_000 });
    await expect(
      handlers.lock({ clone_id: 'A', path: 'packages/foo/bar.ts' }),
    ).rejects.toBeInstanceOf(BusForkingIsolationError);
    expect(await locks.listOwned('A')).toEqual([]);
  });

  it('FR rejection surfaces <missing> castId when registry metadata is incomplete', async () => {
    // Defense in depth: a registry that somehow has cast_mode but no cast_id
    // must still raise, with a sentinel castId. Use crafted metadata since
    // the schema would reject this at register time — we mutate via the FR
    // path that exists in production code (BusForkingIsolationError accepts
    // a castId string).
    await registry.register({
      clone_id: 'A',
      mode: 'forking-realities',
      parent_pid: 1,
      worktree: '/tmp/A',
      // Schema requires cast_id at register time; this metadata satisfies
      // the schema. We then force-drop cast_id below via direct mutation —
      // the handler must not blow up reading a missing field.
      metadata: { cast_id: 'cast-tmp', cast_mode: 'forking-realities' },
    });
    // Simulate runtime corruption: registry record loses cast_id while
    // cast_mode remains. The handler must still raise FR-isolation rather
    // than crashing on a missing field.
    interface RegistryFile {
      version: 1;
      clones: Record<string, { metadata: Record<string, string> }>;
    }
    await atomicMutateJson<RegistryFile>(
      busPaths(root).registry,
      () => ({ version: 1, clones: {} }),
      (current) => {
        const entry = current.clones['A'];
        if (entry) {
          delete entry.metadata.cast_id;
        }
        return current;
      },
    );
    await expect(
      handlers.lock({ clone_id: 'A', path: 'packages/foo/bar.ts' }),
    ).rejects.toMatchObject({
      name: 'BusForkingIsolationError',
      tool: 'manta.lock',
      castId: '<missing>',
    });
  });

  it('regression: non-FR clones still acquire / renew / unlock normally', async () => {
    await registry.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: '/tmp/A',
      metadata: { cast_id: 'cast-1', cast_mode: 'recon-swarm' },
    });
    const acq = await handlers.lock({ clone_id: 'A', path: 'src/foo.ts' });
    expect(acq.lease.owner_clone_id).toBe('A');
    const ren = await handlers.renew({ clone_id: 'A', path: 'src/foo.ts' });
    expect(ren.lease.owner_clone_id).toBe('A');
    const rel = await handlers.unlock({ clone_id: 'A', path: 'src/foo.ts' });
    expect(rel.event.type).toBe('unlock');
  });

  it('regression: unregistered caller falls through (lock acquire still works)', async () => {
    // Unknown clone_id means we can't classify cast_mode — keep the existing
    // permissive behavior (LocksStore will return a fresh lease). Important
    // because tests/tools/locks.test.ts exercises bare clone_ids without
    // a prior registry.register call.
    const r = await handlers.lock({ clone_id: 'GHOST', path: 'src/foo.ts' });
    expect(r.lease.owner_clone_id).toBe('GHOST');
  });
});
