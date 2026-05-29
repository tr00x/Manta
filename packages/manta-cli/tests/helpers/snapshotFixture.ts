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
  /** Real parent Claude session uuid (RB1/bug #56). Distinct from castId by default. */
  parentSessionId?: string | null;
  resumeEnabled?: boolean;
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
    // RB1/bug #56: a parent SESSION id is a different kind of value from the
    // cast id — keep them distinct in fixtures so nothing re-learns the bug.
    parentSessionId:
      opts.parentSessionId !== undefined ? opts.parentSessionId : 'parent-session-test',
    resumeEnabled: opts.resumeEnabled ?? false,
    castId: opts.castId ?? 'cast-test',
    budgetUsd: opts.budgetUsd ?? 5,
    approachHint: opts.approachHint ?? null,
    sessionMode: opts.sessionMode,
    sessionId: opts.sessionId,
  });
}
