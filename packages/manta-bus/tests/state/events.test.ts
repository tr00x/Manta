import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import { FakeClock } from '../../src/clock';
import { busPaths } from '../../src/state/paths';
import { EventsLog } from '../../src/state/events';
import { makeTmpRoot } from '../helpers/tmpRoot';

describe('EventsLog', () => {
  let root: string;
  let cleanup: () => Promise<void>;
  let clock: FakeClock;
  let events: EventsLog;

  beforeEach(async () => {
    ({ root, cleanup } = await makeTmpRoot());
    clock = new FakeClock(1_000_000);
    events = new EventsLog(busPaths(root), clock);
  });
  afterEach(async () => {
    await cleanup();
  });

  it('append writes a JSONL record with timestamp and id', async () => {
    const ev = await events.append({ type: 'broadcast', clone_id: 'A', payload: { x: 1 } });
    // Post-Fix #3: event IDs are length-prefixed monotonic — `<13-digit-ts>-<6-digit-seq>-<rand>`.
    expect(ev.id).toMatch(/^\d{13}-\d{6}-[A-Za-z0-9_-]+$/);
    expect(ev.ts).toBe(1_000_000);
    const lines = (await fs.readFile(busPaths(root).eventsLog, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as { id: string; type: string };
    expect(parsed.id).toBe(ev.id);
    expect(parsed.type).toBe('broadcast');
  });

  it('event ids are strictly increasing under tight-loop append (per-process monotonic)', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      // intentionally do NOT advance the clock — collisions on `now` exercise
      // the per-process counter that breaks ties lex-monotonically.
      const ev = await events.append({ type: 'broadcast', clone_id: 'A', payload: { i } });
      ids.push(ev.id);
    }
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]! > ids[i - 1]!).toBe(true);
    }
  });

  it('readAll skips a truncated last JSONL line and returns the well-formed events', async () => {
    // Regression test for Fix #9: a writer crashing mid-appendFile can leave
    // a partial last line. readAll must not reject the whole file.
    await events.append({ type: 'register', clone_id: 'A', payload: {} });
    await events.append({ type: 'broadcast', clone_id: 'A', payload: { e: 1 } });
    // Manually append a truncated JSON line (no closing brace, no trailing \n).
    await fs.appendFile(busPaths(root).eventsLog, '{"id":"x","ts":99,"type":"broadc');
    const all = await events.readAll();
    expect(all.map((e) => e.type)).toEqual(['register', 'broadcast']);
  });

  it('readAll parses every line into a record', async () => {
    await events.append({ type: 'register', clone_id: 'A', payload: {} });
    clock.advance(1);
    await events.append({ type: 'broadcast', clone_id: 'A', payload: { e: 1 } });
    clock.advance(1);
    await events.append({ type: 'broadcast', clone_id: 'B', payload: { e: 2 } });
    const all = await events.readAll();
    expect(all).toHaveLength(3);
    expect(all.map((e) => e.type)).toEqual(['register', 'broadcast', 'broadcast']);
  });

  it('readSince returns events strictly after the given id', async () => {
    const e0 = await events.append({ type: 'register', clone_id: 'A', payload: {} });
    clock.advance(10);
    await events.append({ type: 'broadcast', clone_id: 'A', payload: { e: 1 } });
    clock.advance(10);
    await events.append({ type: 'broadcast', clone_id: 'A', payload: { e: 2 } });
    const since = await events.readSince(e0.id);
    expect(since.map((e) => e.payload)).toEqual([{ e: 1 }, { e: 2 }]);
  });

  it('readSince does not drop same-millisecond events (regression: bug #42)', async () => {
    // No clock.advance — all three events share ts=1_000_000. A ts cursor
    // (e.ts > cursor) would return [] because nothing is strictly newer than
    // the first event's ts. The id cursor keeps the two later appends.
    const e0 = await events.append({ type: 'broadcast', clone_id: 'A', payload: { e: 0 } });
    await events.append({ type: 'broadcast', clone_id: 'A', payload: { e: 1 } });
    await events.append({ type: 'broadcast', clone_id: 'A', payload: { e: 2 } });
    const since = await events.readSince(e0.id);
    expect(since.map((e) => e.payload)).toEqual([{ e: 1 }, { e: 2 }]);
  });

  it('readSince("") returns all events from the start', async () => {
    await events.append({ type: 'register', clone_id: 'A', payload: {} });
    await events.append({ type: 'broadcast', clone_id: 'A', payload: { e: 1 } });
    const since = await events.readSince('');
    expect(since.map((e) => e.payload)).toEqual([{}, { e: 1 }]);
  });

  it('readAll returns empty array when log file is missing', async () => {
    const all = await events.readAll();
    expect(all).toEqual([]);
  });
});
