import { describe, it, expect } from 'vitest';
import {
  CastOriginSchema,
  SharedBundleManifestSchema,
  type CastOrigin,
  type SharedBundleManifest,
} from '../src/index.js';

const validManifest = (): Record<string, unknown> => ({
  schemaVersion: 1,
  name: '@manta-library/refactor-megapack',
  version: '1.3.0',
  description: 'Mega refactor pack — bulk multi-file refactors with pair-programming clones.',
  author: 'Tim Hunt',
  license: 'MIT',
  mantaVersionCompat: '>=0.7.0 <1.0.0',
});

const validCastOrigin = (): Record<string, unknown> => ({
  castId: 'cast-1780020786877',
  castMode: 'forking-realities',
  originalRepoOrigin: 'https://github.com/u/r.git',
  originalMantaVersion: '0.7.0',
  bundledAt: '2026-05-29T02:13:12Z',
  winningCloneId: 'B',
  provenance: null,
});

const validProvenance = (): Record<string, unknown> => ({
  triggerName: 'on-merge',
  firedAtOffsetMs: 1234,
  parentCastId: 'cast-parent.99',
  causeChain: ['merge-detected', 'tests-green'],
});

describe('CastOriginSchema', () => {
  it('parses a valid user-fired castOrigin (provenance: null)', () => {
    const r = CastOriginSchema.safeParse(validCastOrigin());
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.provenance).toBeNull();
      expect(r.data.castMode).toBe('forking-realities');
    }
  });

  it('round-trips a fully-populated castOrigin with provenance', () => {
    const populated = { ...validCastOrigin(), provenance: validProvenance() };
    const r = CastOriginSchema.safeParse(populated);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.provenance).not.toBeNull();
      expect(r.data.provenance?.triggerName).toBe('on-merge');
      expect(r.data.provenance?.firedAtOffsetMs).toBe(1234);
      expect(r.data.provenance?.parentCastId).toBe('cast-parent.99');
      expect(r.data.provenance?.causeChain).toEqual(['merge-detected', 'tests-green']);
    }
  });

  it('rejects originalRepoOrigin that is a filesystem path, not a URL', () => {
    const r = CastOriginSchema.safeParse({ ...validCastOrigin(), originalRepoOrigin: '/Users/x/repo' });
    expect(r.success).toBe(false);
  });

  it('accepts originalRepoOrigin: null (local-only)', () => {
    const r = CastOriginSchema.safeParse({ ...validCastOrigin(), originalRepoOrigin: null });
    expect(r.success).toBe(true);
  });

  it('rejects a castMode that is not one of the ten Mode literals', () => {
    const r = CastOriginSchema.safeParse({ ...validCastOrigin(), castMode: 'not-a-mode' });
    expect(r.success).toBe(false);
  });

  it('accepts all ten Mode literals for castMode', () => {
    const modes = [
      'recon-swarm', 'forking-realities', 'pair-programming', 'test-storm',
      'bug-hunt', 'refactor-wave', 'documentation-chase',
      'phantom-lance', 'council', 'decoy',
    ];
    for (const m of modes) {
      const r = CastOriginSchema.safeParse({ ...validCastOrigin(), castMode: m });
      expect(r.success, `mode ${m} should parse`).toBe(true);
    }
  });

  it('rejects a provenance.causeChain with more than 8 entries', () => {
    const prov = { ...validProvenance(), causeChain: Array.from({ length: 9 }, (_, i) => `c${i}`) };
    const r = CastOriginSchema.safeParse({ ...validCastOrigin(), provenance: prov });
    expect(r.success).toBe(false);
  });

  it('accepts a provenance.causeChain with exactly 8 entries', () => {
    const prov = { ...validProvenance(), causeChain: Array.from({ length: 8 }, (_, i) => `c${i}`) };
    const r = CastOriginSchema.safeParse({ ...validCastOrigin(), provenance: prov });
    expect(r.success).toBe(true);
  });

  it('accepts provenance.parentCastId: null (user-fired root)', () => {
    const prov = { ...validProvenance(), parentCastId: null };
    const r = CastOriginSchema.safeParse({ ...validCastOrigin(), provenance: prov });
    expect(r.success).toBe(true);
  });

  it('rejects a triggerName shorter than 2 chars', () => {
    const prov = { ...validProvenance(), triggerName: 'x' };
    const r = CastOriginSchema.safeParse({ ...validCastOrigin(), provenance: prov });
    expect(r.success).toBe(false);
  });

  it('rejects a triggerName longer than 48 chars', () => {
    const prov = { ...validProvenance(), triggerName: 'x'.repeat(49) };
    const r = CastOriginSchema.safeParse({ ...validCastOrigin(), provenance: prov });
    expect(r.success).toBe(false);
  });

  it('rejects a non-integer firedAtOffsetMs', () => {
    const prov = { ...validProvenance(), firedAtOffsetMs: 1.5 };
    const r = CastOriginSchema.safeParse({ ...validCastOrigin(), provenance: prov });
    expect(r.success).toBe(false);
  });

  it('rejects an unknown top-level field on castOrigin (.strict)', () => {
    const r = CastOriginSchema.safeParse({ ...validCastOrigin(), bogus: 'x' });
    expect(r.success).toBe(false);
  });

  it('rejects an unknown field inside provenance (.strict)', () => {
    const prov = { ...validProvenance(), bogus: 'x' };
    const r = CastOriginSchema.safeParse({ ...validCastOrigin(), provenance: prov });
    expect(r.success).toBe(false);
  });

  it('rejects a non-semver originalMantaVersion', () => {
    const r = CastOriginSchema.safeParse({ ...validCastOrigin(), originalMantaVersion: '1.0' });
    expect(r.success).toBe(false);
  });

  it('rejects a bundledAt with a timezone offset (offset:false → only Z)', () => {
    const r = CastOriginSchema.safeParse({ ...validCastOrigin(), bundledAt: '2026-05-29T02:13:12+02:00' });
    expect(r.success).toBe(false);
  });

  it('rejects a castId with path-like characters', () => {
    const r = CastOriginSchema.safeParse({ ...validCastOrigin(), castId: '/abs/path' });
    expect(r.success).toBe(false);
  });

  it('exposes a usable inferred type CastOrigin', () => {
    const r = CastOriginSchema.parse(validCastOrigin());
    const typed: CastOrigin = r;
    expect(typed.castId).toBe('cast-1780020786877');
  });
});

describe('SharedBundleManifestSchema', () => {
  it('parses a valid 7a manifest + castOrigin (intersection)', () => {
    const bundle = { ...validManifest(), castOrigin: validCastOrigin() };
    const r = SharedBundleManifestSchema.safeParse(bundle);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.castOrigin.castId).toBe('cast-1780020786877');
      expect(r.data.name).toBe('@manta-library/refactor-megapack');
    }
  });

  it('throws when castOrigin is absent (required for a shared bundle)', () => {
    const r = SharedBundleManifestSchema.safeParse(validManifest());
    expect(r.success).toBe(false);
  });

  it('throws when the base manifest is invalid even if castOrigin is present', () => {
    const bundle = { ...validManifest(), version: '1.0', castOrigin: validCastOrigin() };
    const r = SharedBundleManifestSchema.safeParse(bundle);
    expect(r.success).toBe(false);
  });

  it('exposes a usable inferred type SharedBundleManifest', () => {
    const bundle = { ...validManifest(), castOrigin: validCastOrigin() };
    const r = SharedBundleManifestSchema.parse(bundle);
    const typed: SharedBundleManifest = r;
    expect(typed.castOrigin.winningCloneId).toBe('B');
  });
});
