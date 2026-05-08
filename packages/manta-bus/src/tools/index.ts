import type { Clock } from '../clock';
import type { Registry } from '../state/registry';
import type { LocksStore } from '../state/locks';
import type { ClaimsStore } from '../state/claims';
import type { ContractsStore } from '../state/contracts';
import type { CastsStore } from '../state/casts';
import type { EventsLog } from '../state/events';
import type { BusPaths } from '../state/paths';
import type { MemoryWriters } from '../memory-writers';

/**
 * The shared context every tool handler family receives. Each handler factory
 * may pick a subset via `Pick<BusContext, ...>` so tests can wire only the
 * stores they actually use without faking the rest.
 */
export interface BusContext {
  paths: BusPaths;
  clock: Clock;
  registry: Registry;
  locks: LocksStore;
  claims: ClaimsStore;
  contracts: ContractsStore;
  casts: CastsStore;
  events: EventsLog;
  memoryWriters: MemoryWriters;
}

export type SubsetContext<K extends keyof BusContext> = Pick<BusContext, K>;
