import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FakeClock } from '../../src/clock';
import { busPaths } from '../../src/state/paths';
import { EventsLog } from '../../src/state/events';
import { Registry } from '../../src/state/registry';
import { makeTmpRoot } from '../helpers/tmpRoot';
import { createCommunicationHandlers } from '../../src/tools/communication';
import { BusNotFoundError, BusValidationError } from '../../src/errors';
import type { BusEvent } from '../../src/state/events';

describe('communication handlers', () => {
  let root: string;
  let cleanup: () => Promise<void>;
  let clock: FakeClock;
  let handlers: ReturnType<typeof createCommunicationHandlers>;

  beforeEach(async () => {
    ({ root, cleanup } = await makeTmpRoot());
    clock = new FakeClock(1_000_000);
    const paths = busPaths(root);
    const registry = new Registry(paths, clock);
    await registry.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: '/w',
      metadata: {},
    });
    await registry.register({
      clone_id: 'B',
      mode: 'recon-swarm',
      parent_pid: 2,
      worktree: '/w',
      metadata: {},
    });
    handlers = createCommunicationHandlers({
      events: new EventsLog(paths, clock),
      registry,
    });
  });
  afterEach(async () => {
    await cleanup();
  });

  it('broadcast accepts breakthrough/blocker/dependency only', async () => {
    const r = await handlers.broadcast({
      clone_id: 'A',
      event_type: 'breakthrough',
      payload: { summary: 'root cause found' },
    });
    expect(r.event.type).toBe('broadcast');
    expect(r.event.payload).toMatchObject({
      event_type: 'breakthrough',
      body: { summary: 'root cause found' },
    });
  });

  it('broadcast rejects unknown event types', async () => {
    await expect(
      handlers.broadcast({ clone_id: 'A', event_type: 'gossip', payload: {} }),
    ).rejects.toBeInstanceOf(BusValidationError);
  });

  it('message records direct A→B', async () => {
    const r = await handlers.message({
      from_clone_id: 'A',
      to_clone_id: 'B',
      payload: { hi: 1 },
    });
    expect(r.event.type).toBe('message');
    expect(r.event.payload).toMatchObject({ from: 'A', to: 'B' });
  });

  it('message rejects unknown to_clone_id', async () => {
    await expect(
      handlers.message({ from_clone_id: 'A', to_clone_id: 'GHOST', payload: {} }),
    ).rejects.toBeInstanceOf(BusNotFoundError);
  });

  it('message rejects unknown from_clone_id', async () => {
    await expect(
      handlers.message({ from_clone_id: 'GHOST', to_clone_id: 'A', payload: {} }),
    ).rejects.toBeInstanceOf(BusNotFoundError);
  });

  it('drift_report records score and evidence', async () => {
    const r = await handlers.driftReport({ clone_id: 'A', score: 0.4, evidence: 'wandering' });
    expect(r.event.type).toBe('drift_report');
    expect(r.event.payload).toMatchObject({ score: 0.4 });
  });
});

describe('readBroadcasts handler', () => {
  let root: string;
  let cleanup: () => Promise<void>;
  let clock: FakeClock;
  let events: EventsLog;
  let handlers: ReturnType<typeof createCommunicationHandlers>;

  beforeEach(async () => {
    ({ root, cleanup } = await makeTmpRoot());
    clock = new FakeClock(1_000_000);
    const paths = busPaths(root);
    const registry = new Registry(paths, clock);
    await registry.register({
      clone_id: 'A',
      mode: 'bug-hunt',
      parent_pid: 1,
      worktree: '/w',
      metadata: { cast_id: 'cast-100', cast_mode: 'bug-hunt' },
    });
    await registry.register({
      clone_id: 'B',
      mode: 'bug-hunt',
      parent_pid: 2,
      worktree: '/w2',
      metadata: { cast_id: 'cast-100', cast_mode: 'bug-hunt' },
    });
    await registry.register({
      clone_id: 'C',
      mode: 'recon-swarm',
      parent_pid: 3,
      worktree: '/w3',
      metadata: { cast_id: 'cast-other', cast_mode: 'recon-swarm' },
    });
    events = new EventsLog(paths, clock);
    handlers = createCommunicationHandlers({ events, registry });
  });
  afterEach(async () => {
    await cleanup();
  });

  it('returns sibling broadcasts from same cast', async () => {
    await handlers.broadcast({ clone_id: 'B', event_type: 'breakthrough', payload: { msg: 'found it' } });
    clock.advance(100);
    const result = await handlers.readBroadcasts({ clone_id: 'A', cast_id: 'cast-100' });
    expect(result.events).toHaveLength(1);
    expect((result.events[0] as BusEvent).clone_id).toBe('B');
    expect(((result.events[0] as BusEvent).payload as Record<string, unknown>).event_type).toBe('breakthrough');
  });

  it('excludes own broadcasts', async () => {
    await handlers.broadcast({ clone_id: 'A', event_type: 'blocker', payload: { issue: 'stuck' } });
    clock.advance(50);
    await handlers.broadcast({ clone_id: 'B', event_type: 'breakthrough', payload: { msg: 'ok' } });
    clock.advance(50);
    const result = await handlers.readBroadcasts({ clone_id: 'A', cast_id: 'cast-100' });
    expect(result.events).toHaveLength(1);
    expect((result.events[0] as BusEvent).clone_id).toBe('B');
  });

  it('returns empty for different cast_id', async () => {
    await handlers.broadcast({ clone_id: 'B', event_type: 'breakthrough', payload: { msg: 'x' } });
    clock.advance(100);
    const result = await handlers.readBroadcasts({ clone_id: 'A', cast_id: 'cast-nonexistent' });
    expect(result.events).toHaveLength(0);
  });

  it('respects since_ts filter', async () => {
    await handlers.broadcast({ clone_id: 'B', event_type: 'blocker', payload: { issue: 'first' } });
    clock.advance(100);
    const allBefore = await handlers.readBroadcasts({ clone_id: 'A', cast_id: 'cast-100' });
    const cutoff = (allBefore.events[0] as BusEvent).ts;

    await handlers.broadcast({ clone_id: 'B', event_type: 'breakthrough', payload: { msg: 'second' } });
    clock.advance(100);

    const result = await handlers.readBroadcasts({ clone_id: 'A', cast_id: 'cast-100', since_ts: cutoff });
    expect(result.events).toHaveLength(1);
    expect(((result.events[0] as BusEvent).payload as Record<string, unknown>).event_type).toBe('breakthrough');
  });

  it('works regardless of peer_messaging policy (reads always allowed)', async () => {
    await handlers.broadcast({ clone_id: 'C', event_type: 'dependency', payload: { need: 'data' } });
    clock.advance(100);
    const result = await handlers.readBroadcasts({ clone_id: 'A', cast_id: 'cast-other' });
    expect(result.events).toHaveLength(1);
  });
});
