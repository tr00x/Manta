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
  ChargeStore,
  DailySpendLedger,
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
import { runFeedbackCommand } from '../../src/commands/feedback.js';
import type { Runtime } from '../../src/runtime.js';
import { createLockfileStore } from '../../src/library/lockfile.js';
import { createLocalStore } from '../../src/library/local-store.js';

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
    lockfile: createLockfileStore({ repoRoot: root }),
    localStore: createLocalStore({ homeDir: root }),
    dispose: async () => {},
  };
}

const noopReporter = { info: () => {}, warn: () => {}, error: () => {} };

describe('feedback command', () => {
  let root: string;
  let ctx: BusContext;
  let clock: FakeClock;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-feedback-'));
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
      charges: new ChargeStore(paths, clock),
      dailySpend: new DailySpendLedger(paths, clock),
      memoryWriters: fsMemoryWriters({ repoRoot: root, clock }),
    };
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('rejects unknown clone', async () => {
    const rt = makeRuntime(ctx, root);
    await expect(
      runFeedbackCommand(rt, {
        cloneId: 'Z',
        message: 'test',
        severity: 'info',
        reporter: noopReporter,
      }),
    ).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('appends feedback event with correct severity', async () => {
    await ctx.registry.register({
      clone_id: 'A',
      mode: 'pair-programming',
      parent_pid: 1,
      worktree: '/w',
      metadata: {},
    });

    const rt = makeRuntime(ctx, root);
    const result = await runFeedbackCommand(rt, {
      cloneId: 'A',
      message: 'use smaller functions',
      severity: 'correction',
      reporter: noopReporter,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Feedback sent');

    const events = await ctx.events.readAll();
    const feedbackEvent = events.find((e) => e.type === 'feedback');
    expect(feedbackEvent).toBeDefined();
    expect(feedbackEvent!.clone_id).toBe('A');
    expect((feedbackEvent!.payload as Record<string, unknown>).severity).toBe('correction');
    expect((feedbackEvent!.payload as Record<string, unknown>).from).toBe('main');
  });
});
