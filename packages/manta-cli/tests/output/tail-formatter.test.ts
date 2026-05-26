import { describe, it, expect } from 'vitest';
import { formatTailEvent, formatTailEventRaw } from '../../src/output/tail-formatter.js';
import type { BusEvent } from '@manta/bus';

function makeEvent(overrides: Partial<BusEvent> = {}): BusEvent {
  return {
    id: 'evt-1',
    ts: new Date('2026-05-26T14:05:03.123Z').getTime(),
    type: 'heartbeat',
    clone_id: 'A',
    payload: { state: 'WORKING' },
    ...overrides,
  };
}

describe('formatTailEvent', () => {
  it('formats heartbeat event with timestamp and padded type', () => {
    const line = formatTailEvent(makeEvent());
    expect(line).toMatch(/^\[.*\] heartbeat\s+state="WORKING"$/);
  });

  it('truncates long payload at 80 chars', () => {
    const longPayload = { data: 'x'.repeat(200) };
    const line = formatTailEvent(makeEvent({ payload: longPayload }));
    expect(line).toContain('...');
    expect(line.length).toBeLessThan(200);
  });

  it('aligns type field to 16 chars', () => {
    const short = formatTailEvent(makeEvent({ type: 'hb' }));
    const long = formatTailEvent(makeEvent({ type: 'broadcast_reply' }));
    const shortTypeEnd = short.indexOf(']') + 2 + 16;
    const longTypeEnd = long.indexOf(']') + 2 + 16;
    expect(shortTypeEnd).toBe(longTypeEnd);
  });

  it('handles null payload', () => {
    const line = formatTailEvent(makeEvent({ payload: null }));
    expect(line).toContain('heartbeat');
  });
});

describe('formatTailEventRaw', () => {
  it('produces valid single-line JSON', () => {
    const line = formatTailEventRaw(makeEvent());
    const parsed = JSON.parse(line) as BusEvent;
    expect(parsed.id).toBe('evt-1');
    expect(parsed.type).toBe('heartbeat');
    expect(line).not.toContain('\n');
  });
});
