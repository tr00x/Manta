import { describe, it, expect } from 'vitest';
import { sanitizeEvents, PAYLOAD_ALLOWLIST } from '../../src/share/sanitize-events.js';
import type { BusEvent } from '@manta/bus';

const CREATED_AT = 1780020792392;

const ev = (over: Partial<BusEvent> & Pick<BusEvent, 'type'>): BusEvent => ({
  id: 'id-1',
  ts: CREATED_AT,
  clone_id: 'B',
  payload: {},
  ...over,
});

describe('sanitizeEvents', () => {
  it('projects a broadcast event to { event_type } only (drops free-form body)', () => {
    const events = [
      ev({ type: 'broadcast', ts: 1780020821681, payload: { event_type: 'self_certainty', body: 'free-form leak', score: 8 } }),
    ];
    const { sanitized } = sanitizeEvents(events, { winningCloneId: 'B', castCreatedAt: CREATED_AT });
    expect(sanitized).toHaveLength(1);
    expect(sanitized[0]!.payload).toEqual({ event_type: 'self_certainty' });
  });

  it('projects a heartbeat event to { state } only (drops progress — bug #46)', () => {
    const events = [ev({ type: 'heartbeat', ts: 1780020800000, payload: { state: 'WORKING', progress: 'long free-form text' } })];
    const { sanitized } = sanitizeEvents(events, { winningCloneId: 'B', castCreatedAt: CREATED_AT });
    expect(sanitized[0]!.payload).toEqual({ state: 'WORKING' });
  });

  it('omits the payload entirely for an unknown event type (default-deny)', () => {
    const events = [ev({ type: 'mystery-new-event', payload: { whatever: 'x' } })];
    const { sanitized } = sanitizeEvents(events, { winningCloneId: 'B', castCreatedAt: CREATED_AT });
    expect(sanitized[0]!.payload).toBeNull();
  });

  it('relativises ts to a +<delta>ms offset from castCreatedAt', () => {
    const events = [ev({ type: 'heartbeat', ts: 1780020800000, payload: { state: 'WORKING' } })];
    const { sanitized } = sanitizeEvents(events, { winningCloneId: 'B', castCreatedAt: CREATED_AT });
    // 1780020800000 - 1780020792392 = 7608
    expect(sanitized[0]!.ts).toBe('+7608ms');
  });

  it('excludes events from clones other than the winning clone', () => {
    const events = [
      ev({ type: 'heartbeat', clone_id: 'A', payload: { state: 'WORKING' } }),
      ev({ type: 'heartbeat', clone_id: 'B', payload: { state: 'WORKING' } }),
    ];
    const { sanitized } = sanitizeEvents(events, { winningCloneId: 'B', castCreatedAt: CREATED_AT });
    expect(sanitized).toHaveLength(1);
    expect(sanitized[0]!.clone_id).toBe('B');
  });

  it('drops all payload keys for free-form control events (retask, contract_ack)', () => {
    const events = [
      ev({ type: 'retask', payload: { task: 'free-form operator text' } }),
      ev({ type: 'contract_ack', payload: { interpretation: 'free-form' } }),
    ];
    const { sanitized } = sanitizeEvents(events, { winningCloneId: 'B', castCreatedAt: CREATED_AT });
    expect(sanitized[0]!.payload).toEqual({});
    expect(sanitized[1]!.payload).toEqual({});
  });

  it('preserves the event type and clone_id', () => {
    const events = [ev({ type: 'lock', payload: { path: 'src/a.ts', extra: 'drop' } })];
    const { sanitized } = sanitizeEvents(events, { winningCloneId: 'B', castCreatedAt: CREATED_AT });
    expect(sanitized[0]!.type).toBe('lock');
    expect(sanitized[0]!.clone_id).toBe('B');
    expect(sanitized[0]!.payload).toEqual({ path: 'src/a.ts' });
  });

  // ── Drift guard ──────────────────────────────────────────────────────────
  // The per-type allowlist MUST agree with renderEventPayload
  // (packages/manta-orchestrator/src/post-mortem.ts:159-218). renderEventPayload
  // is module-private (not importable), so this table is copied VERBATIM from
  // those source lines and pinned by this comment. If the orchestrator's
  // projection changes, sync this table and the sanitizer in the same change.
  it('drift guard: PAYLOAD_ALLOWLIST matches renderEventPayload (post-mortem.ts:159-218)', () => {
    const EXPECTED: Record<string, string[]> = {
      register: ['mode'], // :161
      heartbeat: ['state'], // :172
      broadcast: ['event_type'], // :173
      message: ['to', 'channel'], // :175
      drift_report: ['drift_score'], // :177
      feedback: ['severity'], // :179
      claim: ['item', 'target'], // :181-184
      release: ['item', 'target'],
      enqueue_work: ['item', 'target'],
      lock: ['path'], // :185-188
      unlock: ['path'],
      renew_lock: ['path'],
      death: ['reason', 'last_gasp_report_path'], // :189-191
      reaped: ['reason', 'last_gasp_report_path'],
      post_mortem: ['path', 'reason'], // :192-193
      retask: [], // :194-196 (free-form dropped)
      contract_write: [], // :197-201
      contract_ack: [],
      contract_refresh: [],
      suicide_intent: [], // :202-206
      pause: [],
      resume: [],
      request_task: [],
      zk_write: ['note_id', 'folder'], // :207-210
      para_append: ['note_id', 'folder'],
      cast_start: ['cast_id', 'mode', 'amount'], // :211-215
      cast_success: ['cast_id', 'mode', 'amount'],
      cast_fail: ['cast_id', 'mode', 'amount'],
      cast_neutral: ['cast_id', 'mode', 'amount'],
    };
    expect(PAYLOAD_ALLOWLIST).toEqual(EXPECTED);
  });
});
