import { atomicMutateJson, atomicReadJson } from '../atomic-fs';
import type { Clock } from '../clock';
import type { BusPaths } from './paths';

export interface WorkItem {
  id: string;
  cast_id: string;
  target_clone_id: string;
  prompt: string;
  priority: 'normal' | 'high';
  enqueued_at: number;
  claimed_at?: number;
  completed_at?: number;
}

interface WorkQueueFile {
  version: 1;
  items: WorkItem[];
}

const empty = (): WorkQueueFile => ({ version: 1, items: [] });

export class WorkQueueStore {
  constructor(private readonly paths: BusPaths, private readonly clock: Clock) {}

  async enqueue(input: {
    cast_id: string;
    target_clone_id: string;
    prompt: string;
    priority: 'normal' | 'high';
  }): Promise<WorkItem> {
    const now = this.clock.now();
    const id = `wq-${now}-${Math.random().toString(36).slice(2, 8)}`;
    const item: WorkItem = {
      id,
      cast_id: input.cast_id,
      target_clone_id: input.target_clone_id,
      prompt: input.prompt,
      priority: input.priority,
      enqueued_at: now,
    };
    await atomicMutateJson<WorkQueueFile>(
      this.paths.workQueue,
      empty,
      (current) => {
        current.items.push(item);
        return current;
      },
    );
    return item;
  }

  async dequeue(targetCloneId: string): Promise<WorkItem | null> {
    let found: WorkItem | null = null;
    await atomicMutateJson<WorkQueueFile>(
      this.paths.workQueue,
      empty,
      (current) => {
        const idx = current.items.findIndex(
          (i) => i.target_clone_id === targetCloneId && !i.claimed_at,
        );
        const highIdx = current.items.findIndex(
          (i) =>
            i.target_clone_id === targetCloneId &&
            !i.claimed_at &&
            i.priority === 'high',
        );
        const pick = highIdx !== -1 ? highIdx : idx;
        if (pick !== -1) {
          current.items[pick]!.claimed_at = this.clock.now();
          found = { ...current.items[pick]! };
        }
        return current;
      },
    );
    return found;
  }

  async complete(itemId: string): Promise<void> {
    await atomicMutateJson<WorkQueueFile>(
      this.paths.workQueue,
      empty,
      (current) => {
        const item = current.items.find((i) => i.id === itemId);
        if (item) item.completed_at = this.clock.now();
        return current;
      },
    );
  }

  async pending(targetCloneId: string): Promise<WorkItem[]> {
    const file = await atomicReadJson<WorkQueueFile>(this.paths.workQueue, empty);
    return file.items.filter(
      (i) => i.target_clone_id === targetCloneId && !i.claimed_at,
    );
  }
}
