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
import { runDaemonStatusCommand, runDaemonStopCommand } from '../../src/commands/daemon.js';
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

describe('daemon status command', () => {
  let root: string;
  let ctx: BusContext;
  let clock: FakeClock;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-daemon-'));
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

  it('shows empty message when no daemon clones', async () => {
    const rt = makeRuntime(ctx, root);
    const result = await runDaemonStatusCommand(rt, { reporter: noopReporter });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('No active daemon clones.');
  });

  it('shows daemon clones', async () => {
    await ctx.registry.register({
      clone_id: 'A',
      mode: 'pair-programming',
      parent_pid: 1,
      worktree: '/w',
      metadata: {},
    });
    await ctx.registry.heartbeat({ clone_id: 'A', state: 'IDLE' });
    // Set session_mode directly in registry file (spawner does this at registration)
    const regPath = ctx.paths.registry;
    const regData = JSON.parse(await fs.readFile(regPath, 'utf-8'));
    regData.clones.A.session_mode = 'daemon';
    await fs.writeFile(regPath, JSON.stringify(regData));

    const rt = makeRuntime(ctx, root);
    const result = await runDaemonStatusCommand(rt, { reporter: noopReporter });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Active daemon clones:');
    expect(result.stdout).toContain('A');
  });
});

describe('daemon stop command', () => {
  let root: string;
  let ctx: BusContext;
  let clock: FakeClock;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-daemon-'));
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

  it('marks daemon clones DEAD', async () => {
    await ctx.registry.register({
      clone_id: 'A',
      mode: 'pair-programming',
      parent_pid: 1,
      worktree: '/w',
      metadata: {},
    });
    await ctx.registry.heartbeat({ clone_id: 'A', state: 'IDLE' });
    const regPath = ctx.paths.registry;
    const regData = JSON.parse(await fs.readFile(regPath, 'utf-8'));
    regData.clones.A.session_mode = 'daemon';
    await fs.writeFile(regPath, JSON.stringify(regData));

    const rt = makeRuntime(ctx, root);
    const result = await runDaemonStopCommand(rt, { reporter: noopReporter, reason: 'test' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Stopped');

    const updated = await ctx.registry.get('A');
    expect(updated.state).toBe('DEAD');
  });

  it('returns 0 with count=0 when no daemon clones', async () => {
    const rt = makeRuntime(ctx, root);
    const result = await runDaemonStopCommand(rt, { reporter: noopReporter });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('0');
  });
});
