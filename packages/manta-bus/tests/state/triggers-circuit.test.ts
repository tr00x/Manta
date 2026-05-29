import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { busPaths } from '../../src/state/paths';
import { TriggerCircuitStore } from '../../src/state/triggers-circuit';
import { FakeClock } from '../../src/clock';

function tmpRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'manta-circuit-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('TriggerCircuitStore', () => {
  it('is closed on a fresh store', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      expect(await new TriggerCircuitStore(busPaths(dir), new FakeClock(0)).isOpen()).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('trips on 3 budget refusals from 3 distinct triggers within 10m', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const s = new TriggerCircuitStore(busPaths(dir), new FakeClock(0));
      expect((await s.recordBudgetRefusal('ta')).tripped).toBe(false);
      expect((await s.recordBudgetRefusal('tb')).tripped).toBe(false);
      expect((await s.recordBudgetRefusal('tc')).tripped).toBe(true);
      expect(await s.isOpen()).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('does NOT trip on 3 budget refusals from the SAME trigger (distinct-name rule)', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const s = new TriggerCircuitStore(busPaths(dir), new FakeClock(0));
      await s.recordBudgetRefusal('tx');
      await s.recordBudgetRefusal('tx');
      expect((await s.recordBudgetRefusal('tx')).tripped).toBe(false);
      expect(await s.isOpen()).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('prunes budget refusals aged beyond the 10m window', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const clock = new FakeClock(0);
      const s = new TriggerCircuitStore(busPaths(dir), clock);
      await s.recordBudgetRefusal('ta');
      await s.recordBudgetRefusal('tb');
      clock.advance(600_001); // ta + tb now outside the window
      expect((await s.recordBudgetRefusal('tc')).tripped).toBe(false);
      expect(await s.isOpen()).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('trips on 2 depth breaches with the same chain_head within 5m', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const s = new TriggerCircuitStore(busPaths(dir), new FakeClock(0));
      expect((await s.recordDepthBreach('ta')).tripped).toBe(false);
      expect((await s.recordDepthBreach('ta')).tripped).toBe(true);
      expect(await s.isOpen()).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('does NOT trip on 2 depth breaches with different chain heads', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const s = new TriggerCircuitStore(busPaths(dir), new FakeClock(0));
      await s.recordDepthBreach('ta');
      expect((await s.recordDepthBreach('tb')).tripped).toBe(false);
      expect(await s.isOpen()).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('reset closes the breaker and clears the windows', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const s = new TriggerCircuitStore(busPaths(dir), new FakeClock(0));
      await s.recordBudgetRefusal('ta');
      await s.recordBudgetRefusal('tb');
      await s.recordBudgetRefusal('tc');
      expect(await s.isOpen()).toBe(true);
      await s.reset('manual');
      expect(await s.isOpen()).toBe(false);
      // Windows cleared: a single fresh refusal does not immediately re-trip.
      expect((await s.recordBudgetRefusal('ta')).tripped).toBe(false);
    } finally {
      cleanup();
    }
  });
});
