import { describe, it, expect, beforeEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DailySpendLedger } from '../../src/state/daily-spend';
import { FakeClock } from '../../src/clock';
import { busPaths } from '../../src/state/paths';
import type { DailySpendEntry } from '../../src/schema';

describe('DailySpendLedger', () => {
  let tmpDir: string;
  let clock: FakeClock;
  let ledger: DailySpendLedger;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spend-'));
    // 2026-05-26 midday UTC
    clock = new FakeClock(1_779_800_000_000);
    const paths = busPaths(tmpDir);
    ledger = new DailySpendLedger(paths, clock);
  });

  it('read() returns default state on fresh repo', async () => {
    const s = await ledger.read();
    expect(s.version).toBe(1);
    expect(s.tokens_estimated).toBe(0);
    expect(s.entries).toEqual([]);
    expect(s.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('recordCastStart() adds entry and increments tokens_estimated', async () => {
    const entry: Omit<DailySpendEntry, 'started_at'> = {
      cast_id: 'cast-1',
      mode: 'recon-swarm',
      clone_count: 3,
      estimated_tokens: 4.5,
      estimate_type: 'estimate',
    };
    const s = await ledger.recordCastStart(entry);
    expect(s.tokens_estimated).toBe(4.5);
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]!.cast_id).toBe('cast-1');
    expect(s.entries[0]!.started_at).toBe(clock.now());
  });

  it('recordCastStart() auto-resets when date changes', async () => {
    const entry: Omit<DailySpendEntry, 'started_at'> = {
      cast_id: 'cast-1',
      mode: 'recon-swarm',
      clone_count: 3,
      estimated_tokens: 4.5,
      estimate_type: 'estimate',
    };
    await ledger.recordCastStart(entry);

    // Advance clock to next day
    clock.advance(24 * 3600_000);

    const entry2: Omit<DailySpendEntry, 'started_at'> = {
      cast_id: 'cast-2',
      mode: 'forking-realities',
      clone_count: 2,
      estimated_tokens: 6.0,
      estimate_type: 'estimate',
    };
    const s = await ledger.recordCastStart(entry2);
    expect(s.tokens_estimated).toBe(6.0);
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]!.cast_id).toBe('cast-2');
  });

  it('getRemaining() returns dailyTokenCap - tokens_estimated', async () => {
    await ledger.recordCastStart({
      cast_id: 'cast-1',
      mode: 'recon-swarm',
      clone_count: 3,
      estimated_tokens: 20.0,
      estimate_type: 'estimate',
    });
    const remaining = await ledger.getRemaining(50);
    expect(remaining).toBe(30);
  });

  it('getRemaining() returns 0 (not negative) when over cap', async () => {
    await ledger.recordCastStart({
      cast_id: 'cast-1',
      mode: 'recon-swarm',
      clone_count: 3,
      estimated_tokens: 60.0,
      estimate_type: 'estimate',
    });
    const remaining = await ledger.getRemaining(50);
    expect(remaining).toBe(0);
  });

  it('multiple entries accumulate correctly', async () => {
    const base: Omit<DailySpendEntry, 'started_at' | 'cast_id'> = {
      mode: 'recon-swarm',
      clone_count: 2,
      estimated_tokens: 3.0,
      estimate_type: 'estimate',
    };
    await ledger.recordCastStart({ ...base, cast_id: 'c1' });
    await ledger.recordCastStart({ ...base, cast_id: 'c2' });
    const s = await ledger.recordCastStart({ ...base, cast_id: 'c3' });
    expect(s.tokens_estimated).toBe(9.0);
    expect(s.entries).toHaveLength(3);
  });

  it('state survives restart (same date)', async () => {
    await ledger.recordCastStart({
      cast_id: 'cast-1',
      mode: 'recon-swarm',
      clone_count: 3,
      estimated_tokens: 4.5,
      estimate_type: 'estimate',
    });
    const paths = busPaths(tmpDir);
    const ledger2 = new DailySpendLedger(paths, clock);
    const s = await ledger2.read();
    expect(s.tokens_estimated).toBe(4.5);
    expect(s.entries).toHaveLength(1);
  });

  it('date change on read triggers reset', async () => {
    await ledger.recordCastStart({
      cast_id: 'cast-1',
      mode: 'recon-swarm',
      clone_count: 3,
      estimated_tokens: 4.5,
      estimate_type: 'estimate',
    });
    clock.advance(24 * 3600_000);
    const s = await ledger.read();
    expect(s.tokens_estimated).toBe(0);
    expect(s.entries).toEqual([]);
  });
});
