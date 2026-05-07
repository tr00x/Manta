import { describe, it, expect } from 'vitest';
import { systemClock, FakeClock } from '../src/clock';

describe('clock', () => {
  it('systemClock.now returns a number close to Date.now', () => {
    const before = Date.now();
    const value = systemClock.now();
    const after = Date.now();
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(after);
  });

  it('FakeClock starts at the provided epoch', () => {
    const c = new FakeClock(1_000);
    expect(c.now()).toBe(1_000);
  });

  it('FakeClock.advance moves time forward', () => {
    const c = new FakeClock(1_000);
    c.advance(500);
    expect(c.now()).toBe(1_500);
  });

  it('FakeClock.advance rejects negative deltas', () => {
    const c = new FakeClock(1_000);
    expect(() => c.advance(-1)).toThrow(/non-negative/);
  });
});
