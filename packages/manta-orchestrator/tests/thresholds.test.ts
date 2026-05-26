import { describe, it, expect } from 'vitest';
import { defaultThresholds, mergeThresholds, ThresholdsSchema } from '../src/thresholds';

describe('thresholds', () => {
  it('defaults match Sec 6.2 / Sec 6.3 / Sec 9 blocker #5 + Phase 2d dogfood', () => {
    expect(defaultThresholds.heartbeatTimeoutMs).toBe(300_000);
    expect(defaultThresholds.startupGraceMs).toBe(300_000);
    expect(defaultThresholds.staleLockMs).toBe(15_000);
    expect(defaultThresholds.parentPidCheckEnabled).toBe(true);
    expect(defaultThresholds.cycleIntervalMs).toBe(5_000);
    expect(defaultThresholds.postMortemDir).toBe('docs/post-mortems');
  });

  it('mergeThresholds overlays partial overrides', () => {
    const merged = mergeThresholds({ heartbeatTimeoutMs: 60_000 });
    expect(merged.heartbeatTimeoutMs).toBe(60_000);
    expect(merged.staleLockMs).toBe(defaultThresholds.staleLockMs);
  });

  it('ThresholdsSchema rejects negative timeouts', () => {
    expect(() => ThresholdsSchema.parse({ ...defaultThresholds, heartbeatTimeoutMs: -1 })).toThrow();
    expect(() => ThresholdsSchema.parse({ ...defaultThresholds, staleLockMs: 0 })).toThrow();
  });
});
