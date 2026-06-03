import { describe, it, expect } from 'vitest';
import {
  fixModeThresholdDefaults,
  FIX_MODES,
  thresholdUndercutWarnings,
} from '../../src/bin/cast-thresholds.js';

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
      // #M11: daemon FIX modes park clones IDLE between turns; the idle reapers
      // must tolerate at least a full partner turn (heartbeatTimeoutMs) so a
      // correctly-waiting reviewer is not reaped while its writer works.
      expect(d!.idleHeartbeatTimeoutMs).toBeGreaterThanOrEqual(d!.heartbeatTimeoutMs);
      expect(d!.maxIdleTimeMs).toBeGreaterThanOrEqual(d!.heartbeatTimeoutMs);
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

// Bug #M13: an explicit timing flag BELOW the FIX-mode safe default silently
// defeated the protection — warn (override still wins).
describe('thresholdUndercutWarnings (bug #M13)', () => {
  it('warns when --startup-grace-ms undercuts the FIX default', () => {
    const w = thresholdUndercutWarnings('pair-programming', { startupGraceMs: 600_000 });
    expect(w).toHaveLength(1);
    expect(w[0]!.flag).toBe('--startup-grace-ms');
    expect(w[0]!.given).toBe(600_000);
    expect(w[0]!.fixModeDefault).toBe(900_000);
  });

  it('warns when --heartbeat-timeout-ms undercuts the FIX default', () => {
    const w = thresholdUndercutWarnings('refactor-wave', { heartbeatTimeoutMs: 300_000 });
    expect(w.map((x) => x.flag)).toEqual(['--heartbeat-timeout-ms']);
  });

  it('mentions force-full-transcript in the grace hint when that flag is set (#M13 exact case)', () => {
    const w = thresholdUndercutWarnings('pair-programming', {
      startupGraceMs: 600_000,
      forceFullTranscript: true,
    });
    expect(w[0]!.hint).toMatch(/force-full-transcript/);
    expect(w[0]!.hint).toMatch(/#M13/);
  });

  it('does NOT warn when the value is at/above the FIX default', () => {
    expect(thresholdUndercutWarnings('bug-hunt', { startupGraceMs: 900_000 })).toEqual([]);
    expect(thresholdUndercutWarnings('bug-hunt', { startupGraceMs: 1_200_000 })).toEqual([]);
    expect(thresholdUndercutWarnings('test-storm', { heartbeatTimeoutMs: 1_800_000 })).toEqual([]);
  });

  it('does NOT warn for read/quick modes (no FIX default to undercut)', () => {
    expect(thresholdUndercutWarnings('recon-swarm', { startupGraceMs: 1_000 })).toEqual([]);
    expect(thresholdUndercutWarnings('council', { heartbeatTimeoutMs: 1_000 })).toEqual([]);
  });

  it('warns on BOTH flags when both undercut', () => {
    const w = thresholdUndercutWarnings('test-storm', {
      heartbeatTimeoutMs: 60_000,
      startupGraceMs: 60_000,
    });
    expect(w.map((x) => x.flag).sort()).toEqual(['--heartbeat-timeout-ms', '--startup-grace-ms']);
  });
});
