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
  /** Number of times the item has been released back to the queue after a failed attempt (bug #27). */
  attempts?: number;
  /** Wall-clock of the most recent release-after-failure (bug #27). */
  last_failed_at?: number;
  /**
   * Item exceeded `maxAttempts` and will not be re-dequeued (bug #27).
   * Kept in the file for forensics + dashboard surfacing.
   */
  dead_letter?: boolean;
}

interface WorkQueueFile {
  version: 1;
  items: WorkItem[];
}

const empty = (): WorkQueueFile => ({ version: 1, items: [] });

export class WorkQueueStore {
  constructor(private readonly paths: BusPaths, private readonly clock: Clock) {}

  /**
   * Enqueue a new work item.
   *
   * `auditAppend` (optional) is invoked **inside the file mutex**, after the
   * mutator appends the new item to the in-memory list but before the
   * tmp+rename commit — same audit-trail invariant as the single-record
   * mutators on the other stores (bug #24). The closure receives the
   * `WorkItem` (with its fresh `id`) so the caller can log the canonical
   * identifier in the audit line. If `auditAppend` throws, the rename is
   * aborted and the item is not persisted.
   */
  async enqueue(
    input: {
      cast_id: string;
      target_clone_id: string;
      prompt: string;
      priority: 'normal' | 'high';
    },
    auditAppend?: (item: WorkItem) => Promise<void>,
  ): Promise<WorkItem> {
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
      auditAppend ? () => auditAppend(item) : undefined,
    );
    return item;
  }

  async dequeue(targetCloneId: string): Promise<WorkItem | null> {
    let found: WorkItem | null = null;
    await atomicMutateJson<WorkQueueFile>(
      this.paths.workQueue,
      empty,
      (current) => {
        // dead-letter items stay in the file (forensics) but never re-dispatch.
        const isCandidate = (i: WorkItem): boolean =>
          i.target_clone_id === targetCloneId && !i.claimed_at && !i.dead_letter;
        const idx = current.items.findIndex(isCandidate);
        const highIdx = current.items.findIndex(
          (i) => isCandidate(i) && i.priority === 'high',
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

  /**
   * Release a claimed item back to the queue after a failed attempt (bug #27).
   *
   * Clears `claimed_at` and increments `attempts`. If `attempts` reaches
   * `maxAttempts` (default 3), the item is marked `dead_letter: true` and
   * stays in the file for forensics but is never re-dequeued. Returns
   * `{ deadLettered }` so callers can emit the right operator signal.
   *
   * Pre-fix `runDaemonLoop` left failed items with `claimed_at` set forever —
   * the queue grew, work was silently lost. With this method, the daemon
   * loop can release on transient failures and graduate to dead-letter on
   * persistent ones.
   */
  async release(itemId: string, opts?: { maxAttempts?: number }): Promise<{ deadLettered: boolean }> {
    const maxAttempts = opts?.maxAttempts ?? 3;
    let deadLettered = false;
    await atomicMutateJson<WorkQueueFile>(
      this.paths.workQueue,
      empty,
      (current) => {
        const item = current.items.find((i) => i.id === itemId);
        if (!item) return current;
        const nextAttempts = (item.attempts ?? 0) + 1;
        item.attempts = nextAttempts;
        item.last_failed_at = this.clock.now();
        delete item.claimed_at;
        if (nextAttempts >= maxAttempts) {
          item.dead_letter = true;
          deadLettered = true;
        }
        return current;
      },
    );
    return { deadLettered };
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
    // Bug #27: dead-lettered items stay in the file but are never dispatched,
    // so they MUST NOT appear in "pending" — otherwise callers (cast.ts's
    // allDone, dashboards) would loop forever waiting for work that will
    // never be picked up.
    return file.items.filter(
      (i) => i.target_clone_id === targetCloneId && !i.claimed_at && !i.dead_letter,
    );
  }
}
