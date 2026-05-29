import { z } from 'zod';
import { atomicMutateJson, atomicReadJson } from '../atomic-fs';
import type { Clock } from '../clock';
import { TriggerNameSchema } from '../trigger-schema';
import type { EventsLog } from './events';
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
  // Bug #54: `events` is REQUIRED. The two breaker transitions — trip (open)
  // and reset — are precisely the events a forensic replay needs after a lost
  // circuit.json. Pairing the mutation with an events.jsonl append inside the
  // file mutex (bug #24 invariant) is what makes the breaker reconstructable.
  constructor(
    private readonly paths: BusPaths,
    private readonly clock: Clock,
    private readonly events: EventsLog,
  ) {}

  async isOpen(): Promise<boolean> {
    const raw = await atomicReadJson<CircuitFile>(this.paths.triggersCircuit, emptyFile);
    return CircuitFileSchema.parse(raw).open;
  }

  /** Record a budget refusal; trips if ≥3 distinct triggers refused within the budget window. */
  async recordBudgetRefusal(trigger: string): Promise<{ tripped: boolean }> {
    const now = this.clock.now();
    let tripped = false;
    let openedReason: string | null = null;
    await this.mutate(
      (file) => {
        const cutoff = now - BUDGET_WINDOW_MS;
        const pruned = file.budget_refusals.filter((r) => r.ts >= cutoff);
        pruned.push({ trigger, ts: now });
        file.budget_refusals = pruned;
        const distinct = new Set(pruned.map((r) => r.trigger));
        if (!file.open && distinct.size >= BUDGET_DISTINCT_TRIP) {
          file.open = true;
          file.opened_at = now;
          file.opened_reason = `budget-refusal burst: ${distinct.size} distinct triggers within ${BUDGET_WINDOW_MS / 60000}m`;
          openedReason = file.opened_reason;
          tripped = true;
        }
        return file;
      },
      // Bug #54: only the TRIP is audit-worthy. Non-tripping refusals churn the
      // pruned-window array (a changed write) but emit no circuit event — the
      // per-refusal audit lives in fires.jsonl, not events.jsonl.
      async () => {
        if (tripped) {
          await this.appendEvent('trigger_circuit_opened', {
            cause: 'budget_refusal_burst',
            trigger,
            opened_at: now,
            reason: openedReason,
          });
        }
      },
    );
    return { tripped };
  }

  /** Record a depth breach; trips if the same chain_head breached ≥2 times within the depth window. */
  async recordDepthBreach(chainHead: string): Promise<{ tripped: boolean }> {
    const now = this.clock.now();
    let tripped = false;
    let openedReason: string | null = null;
    await this.mutate(
      (file) => {
        const cutoff = now - DEPTH_WINDOW_MS;
        const pruned = file.depth_breaches.filter((b) => b.ts >= cutoff);
        pruned.push({ chain_head: chainHead, ts: now });
        file.depth_breaches = pruned;
        const sameHead = pruned.filter((b) => b.chain_head === chainHead).length;
        if (!file.open && sameHead >= DEPTH_REPEAT_TRIP) {
          file.open = true;
          file.opened_at = now;
          file.opened_reason = `cause-chain depth breached twice for head '${chainHead}' within ${DEPTH_WINDOW_MS / 60000}m`;
          openedReason = file.opened_reason;
          tripped = true;
        }
        return file;
      },
      async () => {
        if (tripped) {
          await this.appendEvent('trigger_circuit_opened', {
            cause: 'depth_breach_repeat',
            chain_head: chainHead,
            opened_at: now,
            reason: openedReason,
          });
        }
      },
    );
    return { tripped };
  }

  /**
   * Reset the breaker to closed/clean state.
   *
   * Bug #54: `reason` is now persisted to the audit trail via a paired
   * `trigger_circuit_reset` events.jsonl append inside the file mutex. The
   * circuit file itself stays forward-only — `opened_reason` reflects the
   * CURRENT trip, so reset clears it back to `null` — but the reset reason
   * lives durably in events.jsonl so a forensic replay can attribute who
   * cleared the breaker and why. (Previously this param was `void`'d pending
   * Chunk 2's audit wiring; that wiring is this change.)
   */
  async reset(reason: string): Promise<void> {
    await this.mutate(
      () => emptyFile(),
      () => this.appendEvent('trigger_circuit_reset', { reason }),
    );
  }

  /**
   * Bug #54: append an audit event from within the circuit.json file mutex,
   * before the tmp+rename commit. A throwing append rolls back the breaker
   * mutation. `clone_id` omitted — the breaker is repo-global, not clone-scoped.
   */
  private async appendEvent(type: string, payload: Record<string, unknown>): Promise<void> {
    await this.events.append({ type, payload });
  }

  private async mutate(
    mutator: (file: CircuitFile) => CircuitFile,
    auditAppend?: () => Promise<void>,
  ): Promise<CircuitFile> {
    return atomicMutateJson<CircuitFile>(
      this.paths.triggersCircuit,
      emptyFile,
      (current) => {
        const parsed = CircuitFileSchema.parse(current);
        return mutator(parsed);
      },
      auditAppend,
    );
  }
}
