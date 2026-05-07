import * as path from 'node:path';
import { CloneIdSchema } from '../schema';

export interface BusPaths {
  readonly repoRoot: string;
  readonly stateDir: string;
  readonly registry: string;
  readonly locks: string;
  readonly claims: string;
  readonly eventsLog: string;
  readonly contractsDir: string;
  readonly lockfileDir: string;
  contractFile(cloneId: string): string;
}

export function busPaths(repoRoot: string): BusPaths {
  if (!repoRoot || repoRoot.trim() === '') {
    throw new Error('busPaths: repoRoot must be a non-empty string');
  }
  const stateDir = path.join(repoRoot, '.manta', 'state');
  return {
    repoRoot,
    stateDir,
    registry: path.join(stateDir, 'registry.json'),
    locks: path.join(stateDir, 'locks.json'),
    claims: path.join(stateDir, 'claims.json'),
    eventsLog: path.join(stateDir, 'events.jsonl'),
    contractsDir: path.join(stateDir, 'contracts'),
    lockfileDir: path.join(stateDir, '.locks'),
    contractFile(cloneId: string): string {
      const parsed = CloneIdSchema.safeParse(cloneId);
      if (!parsed.success) {
        throw new Error(`busPaths.contractFile: invalid clone_id: ${cloneId}`);
      }
      return path.join(stateDir, 'contracts', `${parsed.data}.json`);
    },
  };
}
