import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FakeClock } from '../../src/clock';
import { busPaths } from '../../src/state/paths';
import { EventsLog } from '../../src/state/events';
import { Registry } from '../../src/state/registry';
import { makeTmpRoot } from '../helpers/tmpRoot';
import { createCommunicationHandlers } from '../../src/tools/communication';

describe('manta.message under forking-realities', () => {
  let root: string;
  let cleanup: () => Promise<void>;
  let clock: FakeClock;
  let registry: Registry;
  let handlers: ReturnType<typeof createCommunicationHandlers>;

  beforeEach(async () => {
    ({ root, cleanup } = await makeTmpRoot());
    clock = new FakeClock(1_000_000);
    const paths = busPaths(root);
    registry = new Registry(paths, clock);
    handlers = createCommunicationHandlers({
      events: new EventsLog(paths, clock),
      registry,
    });
  });
  afterEach(async () => {
    await cleanup();
  });

  it('rejects sibling-to-sibling messages with forking_isolation error', async () => {
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
    await expect(
      handlers.message({
        from_clone_id: 'A',
        to_clone_id: 'B',
        payload: { exfil: 'my draft solution' },
      }),
    ).rejects.toMatchObject({
      name: 'BusForkingIsolationError',
      fromCloneId: 'A',
      toCloneId: 'B',
      castId: 'cast-1',
    });
  });

  it('allows recon-swarm sibling-to-sibling messages (regression guard)', async () => {
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
    const r = await handlers.message({
      from_clone_id: 'A',
      to_clone_id: 'B',
      payload: { msg: 'hi' },
    });
    expect(r.event.type).toBe('message');
  });

  it('allows FR clone messaging across different casts', async () => {
    await registry.register({
      clone_id: 'A',
      mode: 'forking-realities',
      parent_pid: 1,
      worktree: '/tmp/A',
      metadata: { cast_id: 'cast-1', cast_mode: 'forking-realities' },
    });
    await registry.register({
      clone_id: 'X',
      mode: 'forking-realities',
      parent_pid: 1,
      worktree: '/tmp/X',
      metadata: { cast_id: 'cast-2', cast_mode: 'forking-realities' },
    });
    const r = await handlers.message({
      from_clone_id: 'A',
      to_clone_id: 'X',
      payload: { msg: 'cross-cast' },
    });
    expect(r.event.type).toBe('message');
  });
});

describe('manta.broadcast cast_id stamp', () => {
  let root: string;
  let cleanup: () => Promise<void>;
  let clock: FakeClock;
  let registry: Registry;
  let handlers: ReturnType<typeof createCommunicationHandlers>;

  beforeEach(async () => {
    ({ root, cleanup } = await makeTmpRoot());
    clock = new FakeClock(1_000_000);
    const paths = busPaths(root);
    registry = new Registry(paths, clock);
    handlers = createCommunicationHandlers({
      events: new EventsLog(paths, clock),
      registry,
    });
  });
  afterEach(async () => {
    await cleanup();
  });

  it('stamps broadcast event with cast_id and cast_mode from registry', async () => {
    await registry.register({
      clone_id: 'A',
      mode: 'forking-realities',
      parent_pid: 1,
      worktree: '/tmp/A',
      metadata: { cast_id: 'cast-fr-1', cast_mode: 'forking-realities' },
    });
    const r = await handlers.broadcast({
      clone_id: 'A',
      event_type: 'breakthrough',
      payload: { what: 'solution found' },
    });
    expect(r.event.payload).toEqual({
      // #M11: clone_id is mirrored into the payload for the dispatch-side reader.
      clone_id: 'A',
      event_type: 'breakthrough',
      body: { what: 'solution found' },
      cast_id: 'cast-fr-1',
      cast_mode: 'forking-realities',
    });
  });

  it('stamps null when clone has no cast metadata', async () => {
    await registry.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: '/tmp/A',
      metadata: {},
    });
    const r = await handlers.broadcast({
      clone_id: 'A',
      event_type: 'blocker',
      payload: { issue: 'stuck' },
    });
    expect(r.event.payload).toMatchObject({
      cast_id: null,
      cast_mode: null,
    });
  });
});
