import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FakeClock } from '../../src/clock';
import { busPaths } from '../../src/state/paths';
import { EventsLog } from '../../src/state/events';
import { Registry } from '../../src/state/registry';
import { makeTmpRoot } from '../helpers/tmpRoot';
import { createCommunicationHandlers } from '../../src/tools/communication';
import { BusNotFoundError, BusValidationError } from '../../src/errors';

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
