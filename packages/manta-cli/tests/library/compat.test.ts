import { describe, it, expect } from 'vitest';
import {
  verifyMantaVersionCompat,
  isMantaVersionCompatible,
  buildCompatErrorMessage,
} from '../../src/library/compat.js';
import type { Lockfile, LockfileEntry } from '../../src/library/lockfile.js';

const entry = (overrides: Partial<LockfileEntry> = {}): LockfileEntry => ({
  version: '1.0.0',
  resolved: 'https://registry.npmjs.org/foo/-/foo-1.0.0.tgz',
  integrity: 'sha256-aaaa==',
  directoryDigest: 'sha256-dddd==',
  contributes: { modes: [], skills: [], commands: [], templates: [] },
  mantaVersionCompat: '>=0.7.0 <1.0.0',
  installedAt: '2026-05-28T11:30:00.000Z',
  ...overrides,
});

const lockFor = (packages: Record<string, LockfileEntry>): Lockfile => ({
  schemaVersion: 1,
  mantaVersion: '0.7.2',
  generatedAt: '2026-05-28T11:30:00.000Z',
  packages,
});

describe('verifyMantaVersionCompat', () => {
  it('returns ok when lockfile is null', () => {
    expect(verifyMantaVersionCompat(null, '0.7.2')).toEqual({ ok: true });
  });

  it('returns ok when every package compat range satisfies the current CLI version', () => {
    const lock = lockFor({
      '@manta-library/a': entry({ mantaVersionCompat: '>=0.7.0 <1.0.0' }),
      '@manta-library/b': entry({ mantaVersionCompat: '*' }),
    });
    expect(verifyMantaVersionCompat(lock, '0.7.2')).toEqual({ ok: true });
  });

  it('returns the first offending package when a compat range is unmet', () => {
    const lock = lockFor({
      '@manta-library/a': entry({ mantaVersionCompat: '>=0.7.0 <1.0.0' }),
      '@manta-library/too-new': entry({ mantaVersionCompat: '>=99.0.0' }),
    });
    const r = verifyMantaVersionCompat(lock, '0.7.2');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.offendingPackage).toBe('@manta-library/too-new');
      expect(r.offendingPackageRange).toBe('>=99.0.0');
      expect(r.currentVersion).toBe('0.7.2');
    }
  });

  it('isMantaVersionCompatible exposes a single-range check', () => {
    expect(isMantaVersionCompatible('>=0.7 <1.0', '0.7.2')).toBe(true);
    expect(isMantaVersionCompatible('>=99', '0.7.2')).toBe(false);
  });
});

describe('buildCompatErrorMessage', () => {
  it('lists upgrade / older-install / uninstall as recovery options', () => {
    const msg = buildCompatErrorMessage({
      offendingPackage: '@manta-library/foo',
      offendingPackageRange: '>=99.0.0',
      currentVersion: '0.7.2',
    });
    expect(msg).toContain('@manta-library/foo');
    expect(msg).toContain('>=99.0.0');
    expect(msg).toContain('0.7.2');
    expect(msg).toContain('Upgrade');
    expect(msg).toContain('older');
    expect(msg).toContain('Uninstall');
  });
});
