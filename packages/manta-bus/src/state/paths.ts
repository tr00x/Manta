import * as path from 'node:path';
import { CastIdSchema, CloneIdSchema } from '../schema';
import { TriggerNameSchema } from '../trigger-schema';

export interface BusPaths {
  readonly repoRoot: string;
  readonly stateDir: string;
  readonly registry: string;
  readonly locks: string;
  readonly claims: string;
  readonly eventsLog: string;
  readonly contractsDir: string;
  readonly castsDir: string;
  readonly lockfileDir: string;
  readonly charges: string;
  readonly chargesLog: string;
  readonly dailySpend: string;
  readonly configDir: string;
  readonly budgetConfig: string;
  readonly workQueue: string;
  readonly triggersDir: string;
  readonly triggersArmed: string;
  readonly triggersFires: string;
  readonly triggersCircuit: string;
  contractFile(cloneId: string): string;
  castFile(castId: string): string;
  triggersDebounce(name: string): string;
}

export function busPaths(repoRoot: string): BusPaths {
  if (!repoRoot || repoRoot.trim() === '') {
    throw new Error('busPaths: repoRoot must be a non-empty string');
  }
  const stateDir = path.join(repoRoot, '.manta', 'state');
  const configDir = path.join(repoRoot, '.manta', 'config');
  return {
    repoRoot,
    stateDir,
    registry: path.join(stateDir, 'registry.json'),
    locks: path.join(stateDir, 'locks.json'),
    claims: path.join(stateDir, 'claims.json'),
    eventsLog: path.join(stateDir, 'events.jsonl'),
    contractsDir: path.join(stateDir, 'contracts'),
    castsDir: path.join(stateDir, 'casts'),
    lockfileDir: path.join(stateDir, '.locks'),
    charges: path.join(stateDir, 'charges.json'),
    chargesLog: path.join(stateDir, 'charges.log'),
    dailySpend: path.join(stateDir, 'daily-spend.json'),
    configDir,
    budgetConfig: path.join(configDir, 'budget.json'),
    workQueue: path.join(stateDir, 'work-queue.json'),
    triggersDir: path.join(stateDir, 'triggers'),
    triggersArmed: path.join(stateDir, 'triggers', 'armed.json'),
    triggersFires: path.join(stateDir, 'triggers', 'fires.jsonl'),
    triggersCircuit: path.join(stateDir, 'triggers', 'circuit.json'),
    contractFile(cloneId: string): string {
      const parsed = CloneIdSchema.safeParse(cloneId);
      if (!parsed.success) {
        throw new Error(`busPaths.contractFile: invalid clone_id: ${cloneId}`);
      }
      return path.join(stateDir, 'contracts', `${parsed.data}.json`);
    },
    castFile(castId: string): string {
      const parsed = CastIdSchema.safeParse(castId);
      if (!parsed.success) {
        throw new Error(`busPaths.castFile: invalid cast_id: ${castId}`);
      }
      return path.join(stateDir, 'casts', `${parsed.data}.json`);
    },
    triggersDebounce(name: string): string {
      // The trigger-name regex (lowercase kebab, 2-48 chars) inherently rejects
      // '/', '..', and any path separator — defence against traversal via a
      // crafted name before we join it under triggers/debounce/.
      const parsed = TriggerNameSchema.safeParse(name);
      if (!parsed.success) {
        throw new Error(`busPaths.triggersDebounce: invalid trigger name: ${name}`);
      }
      return path.join(stateDir, 'triggers', 'debounce', `${parsed.data}.json`);
    },
  };
}
