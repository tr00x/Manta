import type { BusEvent } from '@manta/bus';
import type { SanitizationWarning } from './types.js';

/**
 * Per-event-type payload allowlist for the bundled `events.jsonl` (Phase 7b
 * Task 1.7).
 *
 * The on-disk `events.jsonl` is the RAW event log — its `payload` is NOT
 * pre-sanitized (only the post-mortem *render* projects it). So this table
 * re-implements the exact projection `renderEventPayload` applies
 * (packages/manta-orchestrator/src/post-mortem.ts:159-218). Factoring the
 * orchestrator's switch into a shared table is out of scope (it would touch a
 * frozen file), so the table is duplicated here and a drift-guard test asserts
 * the two agree. Default-deny: any event type NOT in this map has its payload
 * omitted entirely (mirrors the `default: '<payload omitted>'` arm at :216-217).
 *
 * Keep this in sync with post-mortem.ts:159-218 — change both in one edit.
 */
export const PAYLOAD_ALLOWLIST: Record<string, string[]> = {
  register: ['mode'],
  heartbeat: ['state'],
  broadcast: ['event_type'],
  message: ['to', 'channel'],
  drift_report: ['drift_score'],
  feedback: ['severity'],
  claim: ['item', 'target'],
  release: ['item', 'target'],
  enqueue_work: ['item', 'target'],
  lock: ['path'],
  unlock: ['path'],
  renew_lock: ['path'],
  death: ['reason', 'last_gasp_report_path'],
  reaped: ['reason', 'last_gasp_report_path'],
  post_mortem: ['path', 'reason'],
  retask: [],
  contract_write: [],
  contract_ack: [],
  contract_refresh: [],
  suicide_intent: [],
  pause: [],
  resume: [],
  request_task: [],
  zk_write: ['note_id', 'folder'],
  para_append: ['note_id', 'folder'],
  cast_start: ['cast_id', 'mode', 'amount'],
  cast_success: ['cast_id', 'mode', 'amount'],
  cast_fail: ['cast_id', 'mode', 'amount'],
  cast_neutral: ['cast_id', 'mode', 'amount'],
};

export interface SanitizedEvent {
  type: string;
  /** Wallclock `ts` relativised to a `+<delta>ms` offset from castCreatedAt. */
  ts: string;
  clone_id?: string;
  /** Allowlisted payload projection, or `null` for unknown types (default-deny). */
  payload: Record<string, unknown> | null;
}

function projectPayload(type: string, payload: unknown): Record<string, unknown> | null {
  const allow = PAYLOAD_ALLOWLIST[type];
  // Unknown event type → default-deny (payload omitted).
  if (allow === undefined) return null;
  const projection: Record<string, unknown> = {};
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    for (const k of allow) {
      if (k in p) projection[k] = p[k];
    }
  }
  return projection;
}

/**
 * Sanitize the raw bus event timeline for bundling. Filters to the winning
 * clone, projects each payload through the per-type allowlist, and relativises
 * each `ts` to a `+<delta>ms` offset from the cast's `created_at`.
 */
export function sanitizeEvents(
  events: BusEvent[],
  opts: { winningCloneId: string; castCreatedAt: number },
): { sanitized: SanitizedEvent[]; warnings: SanitizationWarning[] } {
  const sanitized: SanitizedEvent[] = [];
  for (const e of events) {
    if (e.clone_id !== opts.winningCloneId) continue;
    const delta = e.ts - opts.castCreatedAt;
    const out: SanitizedEvent = {
      type: e.type,
      ts: `+${delta}ms`,
      payload: projectPayload(e.type, e.payload),
    };
    if (e.clone_id !== undefined) out.clone_id = e.clone_id;
    sanitized.push(out);
  }
  // No warnings: the projection is silent default-deny by design (a dropped
  // free-form field is the expected behaviour, not an anomaly to surface).
  return { sanitized, warnings: [] };
}
