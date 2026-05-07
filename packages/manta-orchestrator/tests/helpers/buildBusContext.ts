import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FakeClock, busPaths, Registry, LocksStore, ClaimsStore, ContractsStore, EventsLog, fsMemoryWriters } from '@manta/bus';
import type { BusContext } from '@manta/bus';

export interface TestBusContext extends BusContext {
  root: string;
  cleanup: () => Promise<void>;
  clock: FakeClock;
}

export async function buildBusContext(epoch = 1_000_000): Promise<TestBusContext> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-orchestrator-test-'));
  await fs.mkdir(path.join(root, '.manta', 'state', 'contracts'), { recursive: true });
  const clock = new FakeClock(epoch);
  const paths = busPaths(root);
  const ctx: TestBusContext = {
    root,
    clock,
    paths,
    registry: new Registry(paths, clock),
    locks: new LocksStore(paths, clock, { staleAfterMs: 15_000 }),
    claims: new ClaimsStore(paths, clock),
    contracts: new ContractsStore(paths, clock),
    events: new EventsLog(paths, clock),
    memoryWriters: fsMemoryWriters({ repoRoot: root, clock }),
    cleanup: async () => fs.rm(root, { recursive: true, force: true }),
  };
  return ctx;
}
