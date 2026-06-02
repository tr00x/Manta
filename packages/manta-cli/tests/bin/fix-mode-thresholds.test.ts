import { describe, it, expect } from 'vitest';
import { fixModeThresholdDefaults, FIX_MODES } from '../../src/bin/cast-thresholds.js';

// Bug #M12: a FIX cast (refactor-wave / bug-hunt / pair-programming /
// test-storm) does long coding stretches + runs a test suite, so a single op
// can exceed the 300s default heartbeatTimeoutMs and the reaper silently kills
// an actively-working clone. FIX modes therefore get a roomier DEFAULT; read /
// quick modes keep the tight default.
describe('fixModeThresholdDefaults (bug #M12)', () => {
  it('FIX modes get roomy heartbeat / startup / tick defaults', () => {
    for (const mode of ['refactor-wave', 'bug-hunt', 'pair-programming', 'test-storm']) {
      const d = fixModeThresholdDefaults(mode);
      expect(d, mode).not.toBeNull();
      expect(d!.heartbeatTimeoutMs).toBe(1_200_000);
      expect(d!.startupGraceMs).toBe(900_000);
      // tick budget must exceed the heartbeat window, else the cast aborts first.
      expect(d!.tickBudgetMs).toBeGreaterThan(d!.heartbeatTimeoutMs);
    }
  });

  it('read / quick modes keep the tight default (null = no override)', () => {
    for (const mode of ['recon-swarm', 'documentation-chase', 'council', 'decoy', 'forking-realities']) {
      expect(fixModeThresholdDefaults(mode), mode).toBeNull();
    }
  });

  it('an unknown mode is not treated as FIX', () => {
    expect(fixModeThresholdDefaults('not-a-mode')).toBeNull();
  });

  it('FIX_MODES is exactly the four mutate+commit modes', () => {
    expect([...FIX_MODES].sort()).toEqual(
      ['bug-hunt', 'pair-programming', 'refactor-wave', 'test-storm'].sort(),
    );
  });
});
