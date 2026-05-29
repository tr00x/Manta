import * as fs from 'node:fs/promises';
import { z } from 'zod';
import { appendJsonLine } from '../atomic-fs';
import type { Clock } from '../clock';
import { CastIdSchema } from '../schema';
import { EventSourceSchema, TriggerNameSchema } from '../trigger-schema';
import type { BusPaths } from './paths';

// Phase 7c Task 1.6 — fires.jsonl is the single audit record of every trigger
// evaluation regardless of outcome, and backs the sliding-window hourly_cap /
// cooldown_s / global-cap counters. Append-only via appendJsonLine (same
// primitive as chargesLog).

export const TriggerRefusalReasonSchema = z.enum([
  'disarmed',
  'pending_dry_run',
  'debounce_active',
  'dedup_hit',
  'cooldown_active',
  'hourly_cap_exhausted',
  'global_hourly_cap_exhausted',
  'cause_chain_depth_exceeded',
  'loop_self_in_chain',
  'loop_listed_in_chain',
  'budget_gate_failed',
  'circuit_open',
  'condition_failed',
  'validation_error',
]);
export type TriggerRefusalReason = z.infer<typeof TriggerRefusalReasonSchema>;

export const TriggerFireRecordSchema = z
  .object({
    ts: z.number().int().nonnegative(),
    trigger: TriggerNameSchema,
    event_source: EventSourceSchema,
    event_type: z.string(),
    decision: z.enum(['spawned', 'refused']),
    reason: TriggerRefusalReasonSchema.optional(), // present iff refused
    cast_id: CastIdSchema.optional(), // present iff spawned
    parent_cast_id: CastIdSchema.nullable().optional(),
    cause_chain: z.array(z.string()).default([]),
    cost_estimate_usd: z.number().nonnegative().optional(),
    dedup_key_hash: z.string().optional(),
    payload_excerpt: z.record(z.unknown()).optional(),
  })
  .strict()
  .superRefine((rec, ctx) => {
    if (rec.decision === 'refused' && rec.reason === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'reason is required when decision is "refused"', path: ['reason'] });
    }
    if (rec.decision === 'spawned' && rec.cast_id === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'cast_id is required when decision is "spawned"', path: ['cast_id'] });
    }
  });
export type TriggerFireRecord = z.infer<typeof TriggerFireRecordSchema>;

export class TriggerFiresLog {
  constructor(
    private readonly paths: BusPaths,
    private readonly clock: Clock,
  ) {}

  /** Stamps ts from the clock and validates the record before appending. */
  async append(record: Omit<TriggerFireRecord, 'ts'>): Promise<void> {
    const full = TriggerFireRecordSchema.parse({ ...record, ts: this.clock.now() });
    await appendJsonLine(this.paths.triggersFires, full);
  }

  /** All records for `name` within the last `windowMs`, oldest-first. */
  async recentFor(name: string, windowMs: number): Promise<TriggerFireRecord[]> {
    const cutoff = this.clock.now() - windowMs;
    return (await this.readAll()).filter((r) => r.trigger === name && r.ts >= cutoff);
  }

  /** Count of `spawned` records across ALL triggers within the last windowMs. */
  async globalSpawnedSince(windowMs: number): Promise<number> {
    const cutoff = this.clock.now() - windowMs;
    return (await this.readAll()).filter((r) => r.decision === 'spawned' && r.ts >= cutoff).length;
  }

  /** Count of any-decision fires for `name` within the last windowMs. */
  async fireCountFor(name: string, windowMs: number): Promise<number> {
    const cutoff = this.clock.now() - windowMs;
    return (await this.readAll()).filter((r) => r.trigger === name && r.ts >= cutoff).length;
  }

  /** Most recent `spawned` record for `name`, or null (cooldown anchor). */
  async lastSpawnedFor(name: string): Promise<TriggerFireRecord | null> {
    const spawned = (await this.readAll()).filter((r) => r.trigger === name && r.decision === 'spawned');
    return spawned[spawned.length - 1] ?? null;
  }

  /** Tail for `list --verbose` — last n records for `name`, newest-first. */
  async tail(name: string, n: number): Promise<TriggerFireRecord[]> {
    const forName = (await this.readAll()).filter((r) => r.trigger === name);
    return forName.slice(-n).reverse();
  }

  /**
   * Parse every line, skipping (defensively) any line that fails to parse — a
   * corrupt audit log must not crash a read. Returns records in append order.
   */
  private async readAll(): Promise<TriggerFireRecord[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.paths.triggersFires, 'utf8');
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'ENOENT') {
        return [];
      }
      throw err;
    }
    const out: TriggerFireRecord[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(line);
      } catch {
        continue; // skip a torn/corrupt line
      }
      const parsed = TriggerFireRecordSchema.safeParse(parsedJson);
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  }
}
