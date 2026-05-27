import type { Mode } from '@manta/bus';
import type { Snapshot } from '@manta/snapshot';
import { buildCloneSnapshot } from '../../src/spawner/snapshot-builder.js';

export interface SnapshotFor {
  cloneId: string;
  castId?: string;
  mode?: Mode;
  task?: string;
  scope?: { allowedPaths?: string[]; forbiddenPaths?: string[]; maxFilesChanged?: number };
  siblingClones?: string[];
  deadlineMs?: number;
  budgetUsd?: number;
  /** Optional per-clone approach hint; null/undefined → contract.approachHint = null. */
  approachHint?: string | null;
  sessionMode?: 'batch' | 'daemon';
  sessionId?: string;
}

export function makeSnapshotFor(opts: SnapshotFor): Snapshot {
  return buildCloneSnapshot({
    cloneId: opts.cloneId,
    mode: opts.mode ?? 'recon-swarm',
    task: opts.task ?? 'unspecified',
    scope: {
      allowedPaths: opts.scope?.allowedPaths ?? ['.'],
      forbiddenPaths: opts.scope?.forbiddenPaths ?? ['.manta/state', 'secrets/'],
      maxFilesChanged: opts.scope?.maxFilesChanged ?? 0,
    },
    siblingClones: opts.siblingClones ?? [],
    deadlineMs: opts.deadlineMs ?? 60_000,
    parentWorktree: '/tmp/parent',
    cloneWorktree: '/tmp/clone',
    parentPid: process.pid,
    parentSessionId: opts.castId ?? 'cast-test',
    castId: opts.castId ?? 'cast-test',
    budgetUsd: opts.budgetUsd ?? 5,
    approachHint: opts.approachHint ?? null,
    sessionMode: opts.sessionMode,
    sessionId: opts.sessionId,
  });
}
