import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { busPaths } from '../../src/state/paths';
import { TriggerFiresLog, TriggerFireRecordSchema } from '../../src/state/triggers-fires';
import { FakeClock } from '../../src/clock';

function tmpRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'manta-fires-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const HOUR = 3600_000;

describe('TriggerFireRecordSchema cross-field invariants', () => {
  it('rejects a refused record with no reason', () => {
    expect(() =>
      TriggerFireRecordSchema.parse({ ts: 1, trigger: 'tx', event_source: 'git', event_type: 'post-commit', decision: 'refused' }),
    ).toThrow();
  });

  it('rejects a spawned record with no cast_id', () => {
    expect(() =>
      TriggerFireRecordSchema.parse({ ts: 1, trigger: 'tx', event_source: 'git', event_type: 'post-commit', decision: 'spawned' }),
    ).toThrow();
  });
});

describe('TriggerFiresLog', () => {
  it('stamps ts from the injected clock', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const log = new TriggerFiresLog(busPaths(dir), new FakeClock(7777));
      await log.append({ trigger: 'tx', event_source: 'git', event_type: 'post-commit', decision: 'refused', reason: 'disarmed', cause_chain: [] });
      const recent = await log.recentFor('tx', HOUR);
      expect(recent[0]?.ts).toBe(7777);
    } finally {
      cleanup();
    }
  });

  it('recentFor returns only records within the window, oldest-first', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const clock = new FakeClock(0);
      const log = new TriggerFiresLog(busPaths(dir), clock);
      clock.set(1000);
      await log.append({ trigger: 'tx', event_source: 'git', event_type: 'e', decision: 'refused', reason: 'disarmed', cause_chain: [] });
      clock.set(1000 + HOUR + 5000); // first record now outside a 1h window
      await log.append({ trigger: 'tx', event_source: 'git', event_type: 'e', decision: 'refused', reason: 'cooldown_active', cause_chain: [] });
      const recent = await log.recentFor('tx', HOUR);
      expect(recent).toHaveLength(1);
      expect(recent[0]?.reason).toBe('cooldown_active');
    } finally {
      cleanup();
    }
  });

  it('globalSpawnedSince counts only spawned across all triggers', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const log = new TriggerFiresLog(busPaths(dir), new FakeClock(10_000));
      await log.append({ trigger: 'ta', event_source: 'git', event_type: 'e', decision: 'spawned', cast_id: 'cast-1', cause_chain: [] });
      await log.append({ trigger: 'tb', event_source: 'git', event_type: 'e', decision: 'spawned', cast_id: 'cast-2', cause_chain: [] });
      await log.append({ trigger: 'tc', event_source: 'git', event_type: 'e', decision: 'refused', reason: 'disarmed', cause_chain: [] });
      expect(await log.globalSpawnedSince(HOUR)).toBe(2);
    } finally {
      cleanup();
    }
  });

  it('fireCountFor counts both spawned and refused for the named trigger', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const log = new TriggerFiresLog(busPaths(dir), new FakeClock(10_000));
      await log.append({ trigger: 'tx', event_source: 'git', event_type: 'e', decision: 'spawned', cast_id: 'cast-1', cause_chain: [] });
      await log.append({ trigger: 'tx', event_source: 'git', event_type: 'e', decision: 'refused', reason: 'cooldown_active', cause_chain: [] });
      await log.append({ trigger: 'ty', event_source: 'git', event_type: 'e', decision: 'spawned', cast_id: 'cast-2', cause_chain: [] });
      expect(await log.fireCountFor('tx', HOUR)).toBe(2);
    } finally {
      cleanup();
    }
  });

  it('lastSpawnedFor returns null when the trigger has only refusals', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const log = new TriggerFiresLog(busPaths(dir), new FakeClock(10_000));
      await log.append({ trigger: 'tx', event_source: 'git', event_type: 'e', decision: 'refused', reason: 'disarmed', cause_chain: [] });
      expect(await log.lastSpawnedFor('tx')).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('lastSpawnedFor returns the most recent spawned record', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const clock = new FakeClock(0);
      const log = new TriggerFiresLog(busPaths(dir), clock);
      clock.set(100);
      await log.append({ trigger: 'tx', event_source: 'git', event_type: 'e', decision: 'spawned', cast_id: 'cast-1', cause_chain: [] });
      clock.set(200);
      await log.append({ trigger: 'tx', event_source: 'git', event_type: 'e', decision: 'spawned', cast_id: 'cast-2', cause_chain: [] });
      const last = await log.lastSpawnedFor('tx');
      expect(last?.cast_id).toBe('cast-2');
    } finally {
      cleanup();
    }
  });

  it('tail returns the last n records newest-first', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const clock = new FakeClock(0);
      const log = new TriggerFiresLog(busPaths(dir), clock);
      for (let i = 1; i <= 6; i++) {
        clock.set(i * 10);
        await log.append({ trigger: 'tx', event_source: 'git', event_type: `e${i}`, decision: 'refused', reason: 'disarmed', cause_chain: [] });
      }
      const tail = await log.tail('tx', 5);
      expect(tail).toHaveLength(5);
      expect(tail[0]?.event_type).toBe('e6');
      expect(tail[4]?.event_type).toBe('e2');
    } finally {
      cleanup();
    }
  });
});
