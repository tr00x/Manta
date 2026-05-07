import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  busPaths,
  Registry,
  LocksStore,
  ClaimsStore,
  ContractsStore,
  EventsLog,
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
  type Thresholds,
} from '@manta/orchestrator';

export interface CreateRuntimeOptions {
  repoRoot: string;
  thresholdOverrides?: Partial<Thresholds>;
}

export interface Runtime {
  repoRoot: string;
  ctx: BusContext;
  orchestrator: Orchestrator;
  thresholds: Thresholds;
  dispose: () => Promise<void>;
}

export async function createRuntime(opts: CreateRuntimeOptions): Promise<Runtime> {
  const repoRoot = path.resolve(opts.repoRoot);
  const stateDir = path.join(repoRoot, '.manta', 'state');
  await fs.mkdir(path.join(stateDir, 'contracts'), { recursive: true });
  await fs.mkdir(path.join(stateDir, '.locks'), { recursive: true });

  const thresholds = opts.thresholdOverrides
    ? mergeThresholds(opts.thresholdOverrides)
    : defaultThresholds;

  const clock = systemClock;
  const paths = busPaths(repoRoot);
  const ctx: BusContext = {
    paths,
    clock,
    registry: new Registry(paths, clock),
    locks: new LocksStore(paths, clock, { staleAfterMs: thresholds.staleLockMs }),
    claims: new ClaimsStore(paths, clock),
    contracts: new ContractsStore(paths, clock),
    events: new EventsLog(paths, clock),
    memoryWriters: fsMemoryWriters({ repoRoot, clock }),
  };

  const orchestrator = new Orchestrator({
    ctx,
    thresholds,
    probe: makeProbe(),
    writer: fsPostMortemWriter({ repoRoot, postMortemDir: thresholds.postMortemDir }),
  });

  return {
    repoRoot,
    ctx,
    orchestrator,
    thresholds,
    dispose: async () => {
      // No resources to release in Phase 0 — placeholder for daemon-mode.
    },
  };
}
