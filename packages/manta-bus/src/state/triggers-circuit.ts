import { z } from 'zod';
import { atomicMutateJson, atomicReadJson } from '../atomic-fs';
import type { Clock } from '../clock';
import { TriggerNameSchema } from '../trigger-schema';
import type { BusPaths } from './paths';

// Phase 7c Task 1.8 — the hard global circuit breaker (research §3.7). Trips on:
//   (a) any 3 DISTINCT triggers refusing for budget reasons within 10 minutes, or
//   (b) a single cause-chain head hitting max_cause_chain_depth twice within 5 minutes.
// When open, the fire path forces all triggers disarmed; the only way out is
// `manta trigger circuit-reset`.

const BUDGET_WINDOW_MS = 600_000; // 10 minutes
const DEPTH_WINDOW_MS = 300_000; // 5 minutes
const BUDGET_DISTINCT_TRIP = 3;
const DEPTH_REPEAT_TRIP = 2;

const CircuitFileSchema = z
  .object({
    version: z.literal(1),
    open: z.boolean(),
    opened_at: z.number().int().nonnegative().nullable(),
    opened_reason: z.string().nullable(),
    budget_refusals: z
      .array(z.object({ trigger: TriggerNameSchema, ts: z.number().int() }).strict())
      .default([]),
    depth_breaches: z
      .array(z.object({ chain_head: z.string(), ts: z.number().int() }).strict())
      .default([]),
  })
  .strict();
type CircuitFile = z.infer<typeof CircuitFileSchema>;

function emptyFile(): CircuitFile {
  return { version: 1, open: false, opened_at: null, opened_reason: null, budget_refusals: [], depth_breaches: [] };
}

export class TriggerCircuitStore {
  constructor(
    private readonly paths: BusPaths,
    private readonly clock: Clock,
  ) {}

  async isOpen(): Promise<boolean> {
    const raw = await atomicReadJson<CircuitFile>(this.paths.triggersCircuit, emptyFile);
    return CircuitFileSchema.parse(raw).open;
  }

  /** Record a budget refusal; trips if ≥3 distinct triggers refused within the budget window. */
  async recordBudgetRefusal(trigger: string): Promise<{ tripped: boolean }> {
    const now = this.clock.now();
    let tripped = false;
    await this.mutate((file) => {
      const cutoff = now - BUDGET_WINDOW_MS;
      const pruned = file.budget_refusals.filter((r) => r.ts >= cutoff);
      pruned.push({ trigger, ts: now });
      file.budget_refusals = pruned;
      const distinct = new Set(pruned.map((r) => r.trigger));
      if (!file.open && distinct.size >= BUDGET_DISTINCT_TRIP) {
        file.open = true;
        file.opened_at = now;
        file.opened_reason = `budget-refusal burst: ${distinct.size} distinct triggers within ${BUDGET_WINDOW_MS / 60000}m`;
        tripped = true;
      }
      return file;
    });
    return { tripped };
  }

  /** Record a depth breach; trips if the same chain_head breached ≥2 times within the depth window. */
  async recordDepthBreach(chainHead: string): Promise<{ tripped: boolean }> {
    const now = this.clock.now();
    let tripped = false;
    await this.mutate((file) => {
      const cutoff = now - DEPTH_WINDOW_MS;
      const pruned = file.depth_breaches.filter((b) => b.ts >= cutoff);
      pruned.push({ chain_head: chainHead, ts: now });
      file.depth_breaches = pruned;
      const sameHead = pruned.filter((b) => b.chain_head === chainHead).length;
      if (!file.open && sameHead >= DEPTH_REPEAT_TRIP) {
        file.open = true;
        file.opened_at = now;
        file.opened_reason = `cause-chain depth breached twice for head '${chainHead}' within ${DEPTH_WINDOW_MS / 60000}m`;
        tripped = true;
      }
      return file;
    });
    return { tripped };
  }

  /**
   * Reset the breaker to closed/clean state.
   *
   * `reason` is for the CALLER's audit trail (e.g. `events.append({type:
   * 'trigger_circuit_reset', reason})` when bug #54's audit-trail wiring
   * lands). This store does not persist it because the circuit is a
   * forward-only state machine — `opened_reason` reflects the CURRENT
   * trip, not history; reset clears it back to `null`. The param exists
   * so the API documents intent at the call site and is ready to thread
   * through to events.append once Chunk 3's audit-trail pairing arrives.
   * Bug-hunt code-review (cast-1780023638705) flagged the previous
   * `void reason;` as misleading API — this comment makes the contract
   * explicit instead.
   */
  async reset(reason: string): Promise<void> {
    void reason; // intentional — see JSDoc above for why this is not persisted yet.
    await this.mutate(() => emptyFile());
  }

  private async mutate(mutator: (file: CircuitFile) => CircuitFile): Promise<CircuitFile> {
    return atomicMutateJson<CircuitFile>(this.paths.triggersCircuit, emptyFile, (current) => {
      const parsed = CircuitFileSchema.parse(current);
      return mutator(parsed);
    });
  }
}
