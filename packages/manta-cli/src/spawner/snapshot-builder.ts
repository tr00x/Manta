import { captureState, type Mode, type Scope, type Snapshot } from '@manta/snapshot';
import { CliError } from '../errors';

export interface CloneSpawnRequest {
  cloneId: string;
  mode: Mode;
  task: string;
  scope: Scope;
  siblingClones: string[];
  /** Deadline in milliseconds; converted to `ttlSeconds` and `taskContract.deadlineSeconds`. */
  deadlineMs: number;
  parentWorktree: string;
  cloneWorktree: string;
  parentPid: number;
  parentSessionId: string;
  castId: string;
  budgetUsd: number;
  budgetTokens?: number;
  approachHint?: string | null;
}

export function buildCloneSnapshot(req: CloneSpawnRequest): Snapshot {
  if (req.budgetUsd <= 0) {
    throw new CliError(`invalid budget for clone ${req.cloneId}: must be > 0`, {
      kind: 'invalid_input',
    });
  }
  const deadlineSeconds = Math.max(1, Math.ceil(req.deadlineMs / 1000));
  return captureState({
    castId: req.castId,
    parentSessionId: req.parentSessionId,
    parentPid: req.parentPid,
    taskContract: {
      cloneId: req.cloneId,
      mode: req.mode,
      task: req.task,
      scope: req.scope,
      approachHint: req.approachHint ?? null,
      siblingClones: req.siblingClones,
      deadlineSeconds,
    },
    recentMessages: [],
    activeTodos: [],
    openFiles: [],
    parentWorktree: req.parentWorktree,
    cloneWorktree: req.cloneWorktree,
    budget: {
      tokensTotal: req.budgetTokens ?? 0,
      tokensUsed: 0,
      dollarsTotal: req.budgetUsd,
      dollarsUsed: 0,
    },
    ttlSeconds: deadlineSeconds,
    siblingCloneIds: req.siblingClones,
  });
}
