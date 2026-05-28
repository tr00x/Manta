import { describe, it, expect } from 'vitest';
import { BroadcastReader } from '../../src/dispatch/broadcast-reader.js';

describe('BroadcastReader', () => {
  it('returns only broadcasts newer than the cursor', async () => {
    const events = [
      { id: '0000000000100-000000-aaa', ts: 100, type: 'broadcast', payload: { cast_id: 'c1', clone_id: 'A', event_type: 'commit_ready', body: {} } },
      { id: '0000000000200-000001-bbb', ts: 200, type: 'broadcast', payload: { cast_id: 'c1', clone_id: 'B', event_type: 'review_complete', body: {} } },
    ];
    const reader = new BroadcastReader('c1', { readAll: async () => events });
    const first = await reader.readNew();
    expect(first).toHaveLength(2);
    expect(first[0]!.clone_id).toBe('A');
    expect(first[0]!.event_type).toBe('commit_ready');
    const second = await reader.readNew();
    expect(second).toHaveLength(0);
  });

  it('filters by cast_id', async () => {
    const events = [
      { id: '0000000000100-000000-aaa', ts: 100, type: 'broadcast', payload: { cast_id: 'c1', clone_id: 'A', event_type: 'commit_ready', body: {} } },
      { id: '0000000000200-000001-bbb', ts: 200, type: 'broadcast', payload: { cast_id: 'c2', clone_id: 'B', event_type: 'docs_ready', body: {} } },
    ];
    const reader = new BroadcastReader('c1', { readAll: async () => events });
    const result = await reader.readNew();
    expect(result).toHaveLength(1);
    expect(result[0]!.clone_id).toBe('A');
  });

  it('ignores non-broadcast events', async () => {
    const events = [
      { id: '0000000000100-000000-aaa', ts: 100, type: 'heartbeat', payload: { clone_id: 'A' } },
      { id: '0000000000200-000001-bbb', ts: 200, type: 'broadcast', payload: { cast_id: 'c1', clone_id: 'A', event_type: 'commit_ready', body: { x: 1 } } },
    ];
    const reader = new BroadcastReader('c1', { readAll: async () => events });
    const result = await reader.readNew();
    expect(result).toHaveLength(1);
    expect(result[0]!.payload).toEqual({ x: 1 });
  });

  it('tracks cursor across multiple calls with growing event lists', async () => {
    let events = [
      { id: '0000000000100-000000-aaa', ts: 100, type: 'broadcast', payload: { cast_id: 'c1', clone_id: 'A', event_type: 'commit_ready', body: {} } },
    ];
    const reader = new BroadcastReader('c1', { readAll: async () => events });
    expect(await reader.readNew()).toHaveLength(1);
    events = [
      ...events,
      { id: '0000000000300-000001-bbb', ts: 300, type: 'broadcast', payload: { cast_id: 'c1', clone_id: 'B', event_type: 'review_complete', body: {} } },
    ];
    const second = await reader.readNew();
    expect(second).toHaveLength(1);
    expect(second[0]!.clone_id).toBe('B');
  });

  // Bug #25 regression: same-millisecond events must not be dropped across
  // readNew() calls. Before the fix, lastProcessedTs used strict > on `ts`,
  // so an event arriving in the same ms as the cursor was silently skipped.
  // Now we track lastProcessedId (lex-sortable monotonic id from bus
  // EventsStore) so per-ms ordering by sequence is honored.
  it('delivers same-ms broadcasts split across two readNew calls (bug #25)', async () => {
    // Both events share ts=500 but have distinct, lex-sortable ids — the
    // second event has a strictly higher per-process sequence number.
    let events = [
      { id: '0000000000500-000000-aaa', ts: 500, type: 'broadcast', payload: { cast_id: 'c1', clone_id: 'A', event_type: 'commit_ready', body: { which: 'first' } } },
    ];
    const reader = new BroadcastReader('c1', { readAll: async () => events });
    const first = await reader.readNew();
    expect(first).toHaveLength(1);
    expect(first[0]!.payload).toEqual({ which: 'first' });

    // Now a sibling clone appends a second broadcast in the same millisecond.
    // The pre-fix implementation would drop it because ts (500) is not
    // strictly greater than lastProcessedTs (500).
    events = [
      ...events,
      { id: '0000000000500-000001-bbb', ts: 500, type: 'broadcast', payload: { cast_id: 'c1', clone_id: 'B', event_type: 'review_complete', body: { which: 'second' } } },
    ];
    const second = await reader.readNew();
    expect(second).toHaveLength(1);
    expect(second[0]!.payload).toEqual({ which: 'second' });

    // Third call returns nothing — the cursor advanced past the second id.
    const third = await reader.readNew();
    expect(third).toHaveLength(0);
  });
});
