import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FakeClock } from '../../src/clock';
import { busPaths } from '../../src/state/paths';
import { Registry } from '../../src/state/registry';
import { makeTmpRoot } from '../helpers/tmpRoot';
import { RegisterInputSchema } from '../../src/schema';
import { BusForkingIsolationError } from '../../src/errors';
import { siblingsInSameForkingCast, crossCloneRead } from '../../src/tools/forking-isolation';

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
