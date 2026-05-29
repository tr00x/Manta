import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { busPaths } from '../../src/state/paths';
import { TriggersArmedStore, TriggerStateError } from '../../src/state/triggers-armed';
import { FakeClock } from '../../src/clock';

function tmpRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'manta-armed-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function store(dir: string, clock = new FakeClock(1000)): TriggersArmedStore {
  return new TriggersArmedStore(busPaths(dir), clock);
}

describe('TriggersArmedStore', () => {
  it('reports disarmed for an unknown trigger on a fresh store', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      expect(await store(dir).getState('tx')).toBe('disarmed');
    } finally {
      cleanup();
    }
  });

  it('setPendingDryRun moves disarmed → pending_dry_run', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const s = store(dir);
      await s.setPendingDryRun('tx');
      expect(await s.getState('tx')).toBe('pending_dry_run');
    } finally {
      cleanup();
    }
  });

  it('arm from pending_dry_run → armed, stamps armed_at + dry-run ok', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const s = store(dir, new FakeClock(4242));
      await s.setPendingDryRun('tx');
      await s.arm('tx', { dryRunEstimateUsd: 2.9 });
      expect(await s.getState('tx')).toBe('armed');
      const file = await s.read();
      expect(file.triggers['tx'].armed_at).toBe(4242);
      expect(file.triggers['tx'].armed_by_dry_run_ok).toBe(true);
      expect(file.triggers['tx'].dry_run_estimate_usd).toBe(2.9);
    } finally {
      cleanup();
    }
  });

  it('arm from disarmed throws illegal_transition (cannot skip dry-run)', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const s = store(dir);
      await expect(s.arm('tx', { dryRunEstimateUsd: 1 })).rejects.toBeInstanceOf(TriggerStateError);
      await expect(s.arm('tx', { dryRunEstimateUsd: 1 })).rejects.toMatchObject({ code: 'illegal_transition' });
      expect(await s.getState('tx')).toBe('disarmed');
    } finally {
      cleanup();
    }
  });

  it('disarm from any state → disarmed, idempotent', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const s = store(dir);
      await s.setPendingDryRun('tx');
      await s.arm('tx', { dryRunEstimateUsd: 1 });
      await s.disarm('tx');
      expect(await s.getState('tx')).toBe('disarmed');
      await s.disarm('tx'); // twice is safe
      expect(await s.getState('tx')).toBe('disarmed');
    } finally {
      cleanup();
    }
  });

  it('disarmAll flips all armed/pending to disarmed and returns the flipped names', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const s = store(dir);
      await s.setPendingDryRun('ta');
      await s.setPendingDryRun('tb');
      await s.arm('tb', { dryRunEstimateUsd: 1 });
      await s.setPendingDryRun('tc');
      await s.disarm('tc');
      const flipped = await s.disarmAll();
      expect(flipped.sort()).toEqual(['ta', 'tb']);
      expect(await s.getState('ta')).toBe('disarmed');
      expect(await s.getState('tb')).toBe('disarmed');
    } finally {
      cleanup();
    }
  });

  it('recordValidationError disarms on the third consecutive error', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const s = store(dir);
      await s.setPendingDryRun('tx');
      await s.arm('tx', { dryRunEstimateUsd: 1 });
      expect((await s.recordValidationError('tx')).disarmed).toBe(false);
      expect((await s.recordValidationError('tx')).disarmed).toBe(false);
      expect((await s.recordValidationError('tx')).disarmed).toBe(true);
      expect(await s.getState('tx')).toBe('disarmed');
    } finally {
      cleanup();
    }
  });

  it('clearValidationErrors resets the counter', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const s = store(dir);
      await s.recordValidationError('tx');
      await s.recordValidationError('tx');
      await s.clearValidationErrors('tx');
      // After clearing, two more errors must NOT disarm (counter restarted).
      expect((await s.recordValidationError('tx')).disarmed).toBe(false);
      expect((await s.recordValidationError('tx')).disarmed).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('serialises 10 parallel disarm calls without corruption', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const s = store(dir);
      await s.setPendingDryRun('tx');
      await s.arm('tx', { dryRunEstimateUsd: 1 });
      await Promise.all(Array.from({ length: 10 }, () => s.disarm('tx')));
      expect(await s.getState('tx')).toBe('disarmed');
    } finally {
      cleanup();
    }
  });
});
