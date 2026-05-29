import * as fs from 'node:fs/promises';
import { z } from 'zod';
import { atomicMutateJson } from '../atomic-fs';
import type { Clock } from '../clock';
import type { BusPaths } from './paths';

// Phase 7c Task 1.7 — debounce collapses event bursts. When an event arrives,
// record { last_event_at, pending_payload }; if another arrives within
// debounce_ms, overwrite (keep latest) and skip. Per-trigger file at
// triggersDebounce(name).

const DebounceEntrySchema = z
  .object({
    last_event_at: z.number().int().nonnegative(),
    pending_payload: z.record(z.unknown()),
  })
  .strict();
type DebounceEntry = z.infer<typeof DebounceEntrySchema>;

export interface DebounceObserveResult {
  fire: boolean;
  payload: Record<string, unknown>;
}

export class TriggerDebounceStore {
  constructor(
    private readonly paths: BusPaths,
    private readonly clock: Clock,
  ) {}

  /**
   * Record an incoming event for `name`.
   *  - { fire: false } if within an active debounce window (caller exits 0, no spawn).
   *  - { fire: true, payload } if no active window OR the window expired (caller proceeds
   *    with the most-recent payload, which is the just-arrived one).
   *
   * debounce_ms === 0 always fires without touching disk.
   */
  async observe(name: string, payload: Record<string, unknown>, debounceMs: number): Promise<DebounceObserveResult> {
    if (debounceMs === 0) {
      return { fire: true, payload };
    }
    const now = this.clock.now();
    const file = this.paths.triggersDebounce(name);
    let fire = false;
    await atomicMutateJson<DebounceEntry | null>(
      file,
      () => null,
      (current) => {
        const parsed = current === null ? null : DebounceEntrySchema.parse(current);
        if (parsed === null || now - parsed.last_event_at >= debounceMs) {
          fire = true;
        } else {
          fire = false;
        }
        // Always record the latest event (resets/extends the window with the freshest payload).
        return { last_event_at: now, pending_payload: payload };
      },
    );
    return { fire, payload };
  }

  /** Remove the file so the next observe starts fresh (called after a spawn). */
  async clear(name: string): Promise<void> {
    try {
      await fs.rm(this.paths.triggersDebounce(name), { force: true });
    } catch {
      // best-effort; absence is the desired post-condition
    }
  }
}
