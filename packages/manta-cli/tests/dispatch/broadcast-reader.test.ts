import { describe, it, expect } from 'vitest';
import { BroadcastReader } from '../../src/dispatch/broadcast-reader.js';

describe('BroadcastReader', () => {
  it('returns only broadcasts newer than lastProcessedTs', async () => {
    const events = [
      { ts: 100, type: 'broadcast', payload: { cast_id: 'c1', clone_id: 'A', event_type: 'commit_ready', body: {} } },
      { ts: 200, type: 'broadcast', payload: { cast_id: 'c1', clone_id: 'B', event_type: 'review_complete', body: {} } },
    ];
    const reader = new BroadcastReader('c1', { readAll: async () => events });
    const first = await reader.readNew();
    expect(first).toHaveLength(2);
    const second = await reader.readNew();
    expect(second).toHaveLength(0);
  });

  it('filters by castId', async () => {
    const events = [
      { ts: 100, type: 'broadcast', payload: { cast_id: 'c1', clone_id: 'A', event_type: 'commit_ready', body: {} } },
      { ts: 200, type: 'broadcast', payload: { cast_id: 'c2', clone_id: 'B', event_type: 'commit_ready', body: {} } },
    ];
    const reader = new BroadcastReader('c1', { readAll: async () => events });
    const result = await reader.readNew();
    expect(result).toHaveLength(1);
    expect(result[0]!.clone_id).toBe('A');
  });

  it('skips non-broadcast events', async () => {
    const events = [
      { ts: 100, type: 'heartbeat', payload: { clone_id: 'A' } },
      { ts: 200, type: 'broadcast', payload: { cast_id: 'c1', clone_id: 'A', event_type: 'commit_ready', body: { x: 1 } } },
    ];
    const reader = new BroadcastReader('c1', { readAll: async () => events });
    const result = await reader.readNew();
    expect(result).toHaveLength(1);
    expect(result[0]!.event_type).toBe('commit_ready');
  });

  it('extracts payload body correctly', async () => {
    const events = [
      { ts: 100, type: 'broadcast', payload: { cast_id: 'c1', clone_id: 'A', event_type: 'commit_ready', body: { commit_ref: 'abc' } } },
    ];
    const reader = new BroadcastReader('c1', { readAll: async () => events });
    const result = await reader.readNew();
    expect(result[0]!.payload).toEqual({ commit_ref: 'abc' });
  });
});
