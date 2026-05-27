import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
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
import {
  Orchestrator,
  defaultThresholds,
  makeProbe,
  inMemoryPostMortemWriter,
  fsMergeReviewWriter,
} from '@manta/orchestrator';
import { runRetaskCommand } from '../../src/commands/retask.js';
import type { Runtime } from '../../src/runtime.js';

function makeRuntime(ctx: BusContext, root: string): Runtime {
  return {
    repoRoot: root,
    ctx,
    orchestrator: new Orchestrator({
      ctx,
      thresholds: defaultThresholds,
      probe: makeProbe({ alive: () => true }),
      writer: inMemoryPostMortemWriter(),
    }),
    thresholds: defaultThresholds,
    mergeReviewWriter: fsMergeReviewWriter({ repoRoot: root, mergeReviewDir: 'docs/merge-reviews' }),
    dispose: async () => {},
  };
}

const noopReporter = { info: () => {}, warn: () => {}, error: () => {} };

describe('retask command', () => {
  let root: string;
  let ctx: BusContext;
  let clock: FakeClock;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-retask-'));
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
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('rejects unknown clone', async () => {
    const rt = makeRuntime(ctx, root);
    await expect(
      runRetaskCommand(rt, { cloneId: 'Z', task: 'new task', reporter: noopReporter }),
    ).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('rejects non-IDLE clone', async () => {
    await ctx.registry.register({
      clone_id: 'A',
      mode: 'pair-programming',
      parent_pid: 1,
      worktree: '/w',
      metadata: {},
    });
    await ctx.registry.heartbeat({ clone_id: 'A', state: 'WORKING' });

    const rt = makeRuntime(ctx, root);
    await expect(
      runRetaskCommand(rt, { cloneId: 'A', task: 'new task', reporter: noopReporter }),
    ).rejects.toMatchObject({ kind: 'retask_failed' });
  });

  it('succeeds for IDLE clone and appends event', async () => {
    await ctx.registry.register({
      clone_id: 'A',
      mode: 'pair-programming',
      parent_pid: 1,
      worktree: '/w',
      metadata: {},
    });
    await ctx.registry.heartbeat({ clone_id: 'A', state: 'IDLE' });

    const rt = makeRuntime(ctx, root);
    const result = await runRetaskCommand(rt, {
      cloneId: 'A',
      task: 'new task description',
      reporter: noopReporter,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Re-tasked');

    const events = await ctx.events.readAll();
    const retaskEvent = events.find((e) => e.type === 'retask');
    expect(retaskEvent).toBeDefined();
    expect(retaskEvent!.clone_id).toBe('A');
  });
});
