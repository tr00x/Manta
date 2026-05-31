import { describe, expect, it } from 'vitest';
import {
  AGHS_LOCKED_MODES,
  aghsLockedMessage,
  assertAghsUnlocked,
  isAghsLocked,
  parseAghsUnlockEnv,
  resolveUnlockedAghsModes,
} from '../../src/config/aghs-gate.js';
import { isCliError } from '../../src/errors.js';

describe('aghs-gate — isAghsLocked', () => {
  it('locks decoy, council, and phantom-lance', () => {
    expect(isAghsLocked('decoy')).toBe(true);
    expect(isAghsLocked('council')).toBe(true);
    expect(isAghsLocked('phantom-lance')).toBe(true);
  });

  it('does not lock the always-available modes', () => {
    expect(isAghsLocked('recon-swarm')).toBe(false);
    expect(isAghsLocked('forking-realities')).toBe(false);
    expect(isAghsLocked('bug-hunt')).toBe(false);
  });

  it('AGHS_LOCKED_MODES is exactly the three Aghs modes', () => {
    expect([...AGHS_LOCKED_MODES].sort()).toEqual(['council', 'decoy', 'phantom-lance']);
  });
});

describe('aghs-gate — parseAghsUnlockEnv', () => {
  it('returns empty for undefined / empty / whitespace', () => {
    expect(parseAghsUnlockEnv(undefined).size).toBe(0);
    expect(parseAghsUnlockEnv('').size).toBe(0);
    expect(parseAghsUnlockEnv('   ').size).toBe(0);
  });

  it('parses a single mode name', () => {
    expect([...parseAghsUnlockEnv('decoy')]).toEqual(['decoy']);
  });

  it('parses a comma/space separated list, case-insensitively', () => {
    expect([...parseAghsUnlockEnv('decoy, COUNCIL')].sort()).toEqual(['council', 'decoy']);
    expect([...parseAghsUnlockEnv('decoy council')].sort()).toEqual(['council', 'decoy']);
  });

  it('wildcards unlock the safe Aghs modes but NEVER phantom-lance', () => {
    for (const wc of ['all', '1', 'true', 'yes', '*']) {
      const set = parseAghsUnlockEnv(wc);
      expect(set.has('decoy')).toBe(true);
      expect(set.has('council')).toBe(true);
      expect(set.has('phantom-lance')).toBe(false);
    }
  });

  it('ignores unknown tokens (a typo never silently unlocks)', () => {
    expect(parseAghsUnlockEnv('decoyy, recon-swarm, nonsense').size).toBe(0);
  });

  it('lets phantom-lance be named explicitly (gate is generic; lock is upstream)', () => {
    expect(parseAghsUnlockEnv('phantom-lance').has('phantom-lance')).toBe(true);
  });
});

describe('aghs-gate — resolveUnlockedAghsModes', () => {
  it('unions config and env', () => {
    const set = resolveUnlockedAghsModes(['decoy'], { MANTA_UNLOCK_AGHS: 'council' });
    expect(set.has('decoy')).toBe(true);
    expect(set.has('council')).toBe(true);
  });

  it('config alone works with no env', () => {
    const set = resolveUnlockedAghsModes(['council'], {});
    expect(set.has('council')).toBe(true);
    expect(set.has('decoy')).toBe(false);
  });

  it('drops non-Aghs config entries defensively', () => {
    const set = resolveUnlockedAghsModes(['recon-swarm' as never], {});
    expect(set.size).toBe(0);
  });
});

describe('aghs-gate — assertAghsUnlocked', () => {
  it('no-ops for non-Aghs modes regardless of unlock set', () => {
    expect(() => assertAghsUnlocked('recon-swarm', new Set())).not.toThrow();
  });

  it('no-ops for an unlocked Aghs mode', () => {
    expect(() => assertAghsUnlocked('decoy', new Set(['decoy']))).not.toThrow();
  });

  it('throws a clear CliError for a locked Aghs mode', () => {
    let caught: unknown;
    try {
      assertAghsUnlocked('council', new Set());
    } catch (e) {
      caught = e;
    }
    expect(isCliError(caught)).toBe(true);
    if (isCliError(caught)) {
      expect(caught.kind).toBe('invalid_input');
      expect(caught.message).toContain('council');
      expect(caught.message).toContain('aghs.unlocked');
      expect(caught.message).toContain('MANTA_UNLOCK_AGHS');
    }
  });

  it('the locked message names both unlock channels', () => {
    const msg = aghsLockedMessage('decoy');
    expect(msg).toContain('.manta/config/budget.json');
    expect(msg).toContain('MANTA_UNLOCK_AGHS=decoy');
  });
});
