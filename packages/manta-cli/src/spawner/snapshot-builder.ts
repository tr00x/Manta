import { captureState, type Mode, type Scope, type Snapshot } from '@manta/snapshot';

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
  /** Real Claude session uuid of the parent, or `null` when unknown (bug #56). */
  parentSessionId: string | null;
  /** Boot the clone as a continuation of the parent transcript. Default false. */
  resumeEnabled?: boolean | undefined;
  castId: string;
  approachHint?: string | null;
  sessionMode?: 'batch' | 'daemon' | undefined;
  sessionId?: string | undefined;
}

export function buildCloneSnapshot(req: CloneSpawnRequest): Snapshot {
  const deadlineSeconds = Math.max(1, Math.ceil(req.deadlineMs / 1000));
  const sessionMode = req.sessionMode ?? 'batch';
  return captureState({
    castId: req.castId,
    parentSessionId: req.parentSessionId,
    resumeEnabled: req.resumeEnabled ?? false,
    parentPid: req.parentPid,
    taskContract: {
      cloneId: req.cloneId,
      mode: req.mode,
      task: req.task,
      scope: req.scope,
      approachHint: req.approachHint ?? null,
      siblingClones: req.siblingClones,
      deadlineSeconds,
      sessionMode,
    },
    recentMessages: [],
    activeTodos: [],
    openFiles: [],
    parentWorktree: req.parentWorktree,
    cloneWorktree: req.cloneWorktree,
    ttlSeconds: deadlineSeconds,
    siblingCloneIds: req.siblingClones,
    sessionMode,
    sessionId: req.sessionId,
  });
}
