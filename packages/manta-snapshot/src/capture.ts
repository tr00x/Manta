import { CURRENT_SCHEMA_VERSION } from './version';
import type {
  Snapshot,
  TaskContract,
  Message,
  Todo,
  OpenFile,
  Budget,
} from './schema';

export interface CaptureInput {
  castId: string;
  parentSessionId: string;
  parentPid: number;
  taskContract: TaskContract;
  recentMessages: Message[];
  activeTodos: Todo[];
  openFiles: OpenFile[];
  parentWorktree: string;
  cloneWorktree: string;
  budget: Budget;
  ttlSeconds: number;
  siblingCloneIds: string[];
}

export function captureState(input: CaptureInput): Snapshot {
  return {
    version: CURRENT_SCHEMA_VERSION,
    castId: input.castId,
    parentSessionId: input.parentSessionId,
    parentPid: input.parentPid,
    createdAt: new Date().toISOString(),
    taskContract: input.taskContract,
    recentMessages: input.recentMessages,
    activeTodos: input.activeTodos,
    openFiles: input.openFiles,
    parentWorktree: input.parentWorktree,
    cloneWorktree: input.cloneWorktree,
    mode: input.taskContract.mode,
    budget: input.budget,
    ttlSeconds: input.ttlSeconds,
    siblingCloneIds: input.siblingCloneIds,
  };
}
