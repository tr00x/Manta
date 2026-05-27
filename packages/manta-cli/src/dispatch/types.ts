export interface DispatchCycleInput {
  idleClones: Array<{ clone_id: string; idle_since: number }>;
  broadcasts: Array<{ clone_id: string; event_type: string; payload: Record<string, unknown> }>;
}

export interface DispatchEnqueuer {
  enqueue: (targetCloneId: string, prompt: string, priority?: 'normal' | 'high') => Promise<void>;
}
