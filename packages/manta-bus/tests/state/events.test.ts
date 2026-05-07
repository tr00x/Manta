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
    expect(ev.id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(ev.ts).toBe(1_000_000);
    const lines = (await fs.readFile(busPaths(root).eventsLog, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as { id: string; type: string };
    expect(parsed.id).toBe(ev.id);
    expect(parsed.type).toBe('broadcast');
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

  it('readSince returns events after a timestamp', async () => {
    await events.append({ type: 'register', clone_id: 'A', payload: {} });
    clock.advance(10);
    await events.append({ type: 'broadcast', clone_id: 'A', payload: { e: 1 } });
    clock.advance(10);
    await events.append({ type: 'broadcast', clone_id: 'A', payload: { e: 2 } });
    const since = await events.readSince(1_000_005);
    expect(since.map((e) => e.payload)).toEqual([{ e: 1 }, { e: 2 }]);
  });

  it('readAll returns empty array when log file is missing', async () => {
    const all = await events.readAll();
    expect(all).toEqual([]);
  });
});
