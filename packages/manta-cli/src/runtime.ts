import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  busPaths,
  Registry,
  LocksStore,
  ClaimsStore,
  ContractsStore,
  CastsStore,
  EventsLog,
  WorkQueueStore,
  TriggersArmedStore,
  TriggerFiresLog,
  TriggerDebounceStore,
  TriggerCircuitStore,
  fsMemoryWriters,
  systemClock,
  type BusContext,
} from '@manta/bus';
import {
  Orchestrator,
  defaultThresholds,
  mergeThresholds,
  makeProbe,
  fsPostMortemWriter,
  fsMergeReviewWriter,
  type Thresholds,
  type MergeReviewWriter,
} from '@manta/orchestrator';

import { CliError } from './errors.js';
import { createLockfileStore, type LockfileStore } from './library/lockfile.js';
import { createLocalStore, type LocalStore } from './library/local-store.js';

export interface CreateRuntimeOptions {
  repoRoot: string;
  thresholdOverrides?: Partial<Thresholds>;
  /** Override the global library home — defaults to os.homedir(). Tests use a sandbox dir. */
  homeDir?: string;
}

export interface Runtime {
  repoRoot: string;
  ctx: BusContext;
  orchestrator: Orchestrator;
  thresholds: Thresholds;
  mergeReviewWriter: MergeReviewWriter;
  lockfile: LockfileStore;
  localStore: LocalStore;
  dispose: () => Promise<void>;
}

export async function createRuntime(opts: CreateRuntimeOptions): Promise<Runtime> {
  const repoRoot = path.resolve(opts.repoRoot);
  // I-3 (Chunk-1 review): validate repoRoot is a git repo before scribbling
  // .manta/state into a non-repo directory. Operators who run `manta cast`
  // outside a git checkout get a fast, actionable error instead of cryptic
  // worktree failures three steps later.
  try {
    await fs.access(path.join(repoRoot, '.git'));
  } catch (cause) {
    throw new CliError(`not a git repo root: ${repoRoot}`, {
      kind: 'invalid_input',
      cause,
    });
  }
  const stateDir = path.join(repoRoot, '.manta', 'state');
  await fs.mkdir(path.join(stateDir, 'contracts'), { recursive: true });
  await fs.mkdir(path.join(stateDir, 'casts'), { recursive: true });
  await fs.mkdir(path.join(stateDir, '.locks'), { recursive: true });
  await fs.mkdir(path.join(stateDir, 'timelines'), { recursive: true });

  const thresholds = opts.thresholdOverrides
    ? mergeThresholds(opts.thresholdOverrides)
    : defaultThresholds;

  const clock = systemClock;
  const paths = busPaths(repoRoot);
  // events is constructed up front so the trigger stores that pair mutations
  // with an audit append (bug #54: triggersArmed, triggerCircuit) share the
  // same EventsLog instance the rest of the bus writes to.
  const events = new EventsLog(paths, clock);
  const ctx: BusContext = {
    paths,
    clock,
    registry: new Registry(paths, clock),
    locks: new LocksStore(paths, clock, { staleAfterMs: thresholds.staleLockMs }),
    claims: new ClaimsStore(paths, clock),
    contracts: new ContractsStore(paths, clock),
    casts: new CastsStore(paths, clock),
    events,
    // Bug #20: workQueue must be present in production ctx — Phase 5/6 daemon
    // modes (pair-programming, test-storm, documentation-chase) and the
    // retask command all branch on `rt.ctx.workQueue` being defined. Prior
    // to this fix the runtime omitted it, so those Wave-2 features were silent
    // no-ops in production while tests passed (tests wire workQueue manually).
    workQueue: new WorkQueueStore(paths, clock),
    memoryWriters: fsMemoryWriters({ repoRoot, clock }),
    // Phase 7c Task 2.1: the four trigger stores. Armed + Circuit take the
    // shared `events` log so their state transitions are audit-paired (bug #54).
    triggersArmed: new TriggersArmedStore(paths, clock, events),
    triggerFires: new TriggerFiresLog(paths, clock),
    triggerDebounce: new TriggerDebounceStore(paths, clock),
    triggerCircuit: new TriggerCircuitStore(paths, clock, events),
  };

  const orchestrator = new Orchestrator({
    ctx,
    thresholds,
    probe: makeProbe(),
    writer: fsPostMortemWriter({ repoRoot, postMortemDir: thresholds.postMortemDir }),
  });

  const mergeReviewWriter = fsMergeReviewWriter({
    repoRoot,
    mergeReviewDir: thresholds.mergeReviewDir,
  });

  const lockfile = createLockfileStore({ repoRoot });
  const localStore = createLocalStore(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {});

  return {
    repoRoot,
    ctx,
    orchestrator,
    thresholds,
    mergeReviewWriter,
    lockfile,
    localStore,
    dispose: async () => {
      // No resources to release in Phase 0 — placeholder for daemon-mode.
    },
  };
}
