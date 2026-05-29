import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { busPaths } from '../../src/state/paths';
import { TriggerDebounceStore } from '../../src/state/triggers-debounce';
import { FakeClock } from '../../src/clock';

function tmpRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'manta-debounce-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('TriggerDebounceStore', () => {
  it('debounceMs 0 always fires and writes no file', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const paths = busPaths(dir);
      const s = new TriggerDebounceStore(paths, new FakeClock(0));
      const r = await s.observe('tx', { a: 1 }, 0);
      expect(r.fire).toBe(true);
      expect(existsSync(paths.triggersDebounce('tx'))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('first event fires; a second within the window does not, and keeps the latest payload', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const clock = new FakeClock(1000);
      const s = new TriggerDebounceStore(busPaths(dir), clock);
      expect((await s.observe('tx', { n: 1 }, 5000)).fire).toBe(true);
      clock.advance(1000);
      const second = await s.observe('tx', { n: 2 }, 5000);
      expect(second.fire).toBe(false);
      // The window has now been refreshed; advancing past it fires with the latest event.
      clock.advance(5000);
      const third = await s.observe('tx', { n: 3 }, 5000);
      expect(third.fire).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('an event after window expiry fires again', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const clock = new FakeClock(0);
      const s = new TriggerDebounceStore(busPaths(dir), clock);
      expect((await s.observe('tx', { n: 1 }, 5000)).fire).toBe(true);
      clock.advance(5000); // exactly the window — >= debounceMs fires
      expect((await s.observe('tx', { n: 2 }, 5000)).fire).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('clear removes the file so the next observe starts fresh', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const paths = busPaths(dir);
      const clock = new FakeClock(0);
      const s = new TriggerDebounceStore(paths, clock);
      await s.observe('tx', { n: 1 }, 5000);
      expect(existsSync(paths.triggersDebounce('tx'))).toBe(true);
      await s.clear('tx');
      expect(existsSync(paths.triggersDebounce('tx'))).toBe(false);
      // Fresh: fires immediately even though no time advanced.
      expect((await s.observe('tx', { n: 2 }, 5000)).fire).toBe(true);
    } finally {
      cleanup();
    }
  });
});
