import type { Clock } from '../clock';
import type { Registry } from '../state/registry';
import type { LocksStore } from '../state/locks';
import type { ClaimsStore } from '../state/claims';
import type { ContractsStore } from '../state/contracts';
import type { CastsStore } from '../state/casts';
import type { EventsLog } from '../state/events';
import type { BusPaths } from '../state/paths';
import type { MemoryWriters } from '../memory-writers';
import type { WorkQueueStore } from '../state/work-queue';
import type { TriggersArmedStore } from '../state/triggers-armed';
import type { TriggerFiresLog } from '../state/triggers-fires';
import type { TriggerDebounceStore } from '../state/triggers-debounce';
import type { TriggerCircuitStore } from '../state/triggers-circuit';

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
  workQueue?: WorkQueueStore;
  // Phase 7c — the four trigger state stores. triggersArmed + triggerCircuit
  // carry the bug #54 EventsLog audit-trail dep; all four resolve off the same
  // stateDir as the rest of the bus stores. The fire orchestrator (Chunk 3)
  // and the trigger CLI commands consume them through this context.
  //
  // Optional for the same reason workQueue is (bug #20 idiom): handler-family
  // tests wire `Pick<BusContext, …>` subsets and partial ctx literals that
  // don't need triggers. Production literals (createRuntime, the MCP server)
  // ALWAYS construct them, and a runtime regression test asserts that — so the
  // "optional in type, always present in prod" contract is guarded, not hoped.
  triggersArmed?: TriggersArmedStore;
  triggerFires?: TriggerFiresLog;
  triggerDebounce?: TriggerDebounceStore;
  triggerCircuit?: TriggerCircuitStore;
}

export type SubsetContext<K extends keyof BusContext> = Pick<BusContext, K>;
