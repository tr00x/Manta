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

  it('new daemon threshold fields have correct defaults', () => {
    expect(defaultThresholds.idleHeartbeatTimeoutMs).toBe(600_000);
    expect(defaultThresholds.maxIdleTimeMs).toBe(300_000);
    expect(defaultThresholds.daemonMaxLifetimeMs).toBe(3_600_000);
  });

  it('new daemon threshold fields parse correctly with schema defaults', () => {
    const partial = {
      heartbeatTimeoutMs: 90_000,
      startupGraceMs: 90_000,
      staleLockMs: 15_000,
      parentPidCheckEnabled: true,
      cycleIntervalMs: 5_000,
      postMortemDir: 'docs/post-mortems',
      mergeReviewDir: 'docs/merge-reviews',
      timelinesDir: '.manta/state/timelines',
    };
    const parsed = ThresholdsSchema.parse(partial);
    expect(parsed.idleHeartbeatTimeoutMs).toBe(600_000);
    expect(parsed.maxIdleTimeMs).toBe(300_000);
    expect(parsed.daemonMaxLifetimeMs).toBe(3_600_000);
  });

  it('mergeThresholds carries daemon defaults when not overridden', () => {
    const merged = mergeThresholds({ heartbeatTimeoutMs: 60_000 });
    expect(merged.idleHeartbeatTimeoutMs).toBe(600_000);
    expect(merged.maxIdleTimeMs).toBe(300_000);
    expect(merged.daemonMaxLifetimeMs).toBe(3_600_000);
  });
});
