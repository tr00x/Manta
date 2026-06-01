import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runTickLoop } from '../src/tick-loop.js';
import {
  Orchestrator,
  defaultThresholds,
  makeProbe,
  inMemoryPostMortemWriter,
} from '@manta/orchestrator';
import {
  busPaths,
  FakeClock,
  Registry,
  LocksStore,
  ClaimsStore,
  ContractsStore,
  CastsStore,
  EventsLog,
  fsMemoryWriters,
  type BusContext,
} from '@manta/bus';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

describe('runTickLoop', () => {
  let root: string;
  let cleanup: () => Promise<void>;
  let ctx: BusContext;
  let clock: FakeClock;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-tick-'));
    await fs.mkdir(path.join(root, '.manta', 'state', '.locks'), { recursive: true });
    await fs.mkdir(path.join(root, '.manta', 'state', 'contracts'), { recursive: true });
    await fs.mkdir(path.join(root, '.manta', 'state', 'casts'), { recursive: true });
    clock = new FakeClock(1_000_000);
    const paths = busPaths(root);
    ctx = {
      paths,
      clock,
      registry: new Registry(paths, clock),
      locks: new LocksStore(paths, clock, { staleAfterMs: 15_000 }),
      claims: new ClaimsStore(paths, clock),
      contracts: new ContractsStore(paths, clock),
      casts: new CastsStore(paths, clock),
      events: new EventsLog(paths, clock),
      memoryWriters: fsMemoryWriters({ repoRoot: root, clock }),
    };
    cleanup = async () => {
      await fs.rm(root, { recursive: true, force: true });
    };
  });
  afterEach(async () => {
    await cleanup();
  });

  it('runs until allDone resolves', async () => {
    const orch = new Orchestrator({
      ctx,
      thresholds: defaultThresholds,
      probe: makeProbe({ alive: () => true }),
      writer: inMemoryPostMortemWriter(),
    });
    let ticks = 0;
    const result = await runTickLoop({
      orchestrator: orch,
      intervalMs: 5,
      allDone: () => {
        ticks += 1;
        return Promise.resolve(ticks >= 3);
      },
    });
    expect(result.cycles).toBeGreaterThanOrEqual(3);
  });

  it('stops on AbortSignal', async () => {
    const orch = new Orchestrator({
      ctx,
      thresholds: defaultThresholds,
      probe: makeProbe({ alive: () => true }),
      writer: inMemoryPostMortemWriter(),
    });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 30);
    const result = await runTickLoop({
      orchestrator: orch,
      intervalMs: 5,
      allDone: () => Promise.resolve(false),
      signal: ctrl.signal,
    });
    expect(result.aborted).toBe(true);
  });

  it('does not leak abort listeners across many cycles sharing one AbortSignal', async () => {
    const orch = new Orchestrator({
      ctx,
      thresholds: defaultThresholds,
      probe: makeProbe({ alive: () => true }),
      writer: inMemoryPostMortemWriter(),
    });
    const ctrl = new AbortController();
    let warning: Error | undefined;
    const onWarn = (w: Error): void => {
      if (w.name === 'MaxListenersExceededWarning') warning = w;
    };
    process.on('warning', onWarn);
    try {
      let ticks = 0;
      await runTickLoop({
        orchestrator: orch,
        intervalMs: 0,
        allDone: () => {
          ticks += 1;
          return Promise.resolve(ticks >= 50);
        },
        signal: ctrl.signal,
      });
    } finally {
      process.off('warning', onWarn);
    }
    expect(warning).toBeUndefined();
    // Listener count on the signal should stay flat, not grow with cycles.
    const listenerCount = (ctrl.signal as unknown as { listenerCount?: (e: string) => number })
      .listenerCount?.('abort') ?? 0;
    expect(listenerCount).toBeLessThanOrEqual(1);
  });

  it('daemon mode: loop survives when clones are IDLE (allDone returns false)', async () => {
    const orch = new Orchestrator({
      ctx,
      thresholds: defaultThresholds,
      probe: makeProbe({ alive: () => true }),
      writer: inMemoryPostMortemWriter(),
    });
    let ticks = 0;
    const result = await runTickLoop({
      orchestrator: orch,
      intervalMs: 5,
      daemonMode: true,
      allDone: () => {
        ticks += 1;
        // Simulate: first 3 ticks clones are IDLE (not done), then done
        return Promise.resolve(ticks >= 4);
      },
    });
    expect(result.cycles).toBeGreaterThanOrEqual(4);
    expect(result.aborted).toBe(false);
  });

  it('daemon mode: loop exits when allDone returns true (all DEAD)', async () => {
    const orch = new Orchestrator({
      ctx,
      thresholds: defaultThresholds,
      probe: makeProbe({ alive: () => true }),
      writer: inMemoryPostMortemWriter(),
    });
    const result = await runTickLoop({
      orchestrator: orch,
      intervalMs: 5,
      daemonMode: true,
      allDone: () => Promise.resolve(true),
    });
    expect(result.cycles).toBe(1);
    expect(result.aborted).toBe(false);
  });

  it('calls onCycleComplete after each orchestrator cycle', async () => {
    const orch = new Orchestrator({
      ctx,
      thresholds: defaultThresholds,
      probe: makeProbe({ alive: () => true }),
      writer: inMemoryPostMortemWriter(),
    });
    let ticks = 0;
    const onCycleComplete = vi.fn();
    const result = await runTickLoop({
      orchestrator: orch,
      intervalMs: 5,
      allDone: () => {
        ticks += 1;
        return Promise.resolve(ticks >= 3);
      },
      onCycleComplete,
    });
    expect(onCycleComplete).toHaveBeenCalledTimes(3);
    expect(onCycleComplete).toHaveBeenCalledWith(expect.objectContaining({ ranAt: expect.any(Number) }));
  });

  it('wraps orchestrator failures via CliError without breaking the loop contract', async () => {
    const orch = new Orchestrator({
      ctx,
      thresholds: defaultThresholds,
      probe: {
        alive: () => {
          throw new Error('probe blew up');
        },
      },
      writer: inMemoryPostMortemWriter(),
    });
    await ctx.registry.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: '/w',
      metadata: {},
    });
    await expect(
      runTickLoop({
        orchestrator: orch,
        intervalMs: 5,
        allDone: () => Promise.resolve(false),
      }),
    ).rejects.toMatchObject({ name: 'CliError', kind: 'orchestrator_failed' });
  });
});
