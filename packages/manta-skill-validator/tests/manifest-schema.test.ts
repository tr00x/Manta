import { describe, it, expect } from 'vitest';
import {
  MantaPackageManifestSchema,
  LibraryModeJsonSchema,
  type MantaPackageManifest,
  type LibraryModeJson,
} from '../src/manifest-schema.js';

const validManifest = (): unknown => ({
  schemaVersion: 1,
  name: '@manta-library/refactor-megapack',
  version: '1.3.0',
  description: 'Mega refactor pack — bulk multi-file refactors with pair-programming clones.',
  author: 'Tim Hunt',
  license: 'MIT',
  mantaVersionCompat: '>=0.7.0 <1.0.0',
});

const validMode = (): unknown => ({
  name: 'mega-refactor',
  description: 'Bulk N-file refactor in pair-programming mode',
  basedOn: 'pair-programming',
  cloneCount: { min: 2, max: 4 },
  sessionMode: 'batch',
});

describe('MantaPackageManifestSchema', () => {
  it('parses a minimal valid manifest and defaults contributes arrays to []', () => {
    const r = MantaPackageManifestSchema.safeParse(validManifest());
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.contributes.skills).toEqual([]);
      expect(r.data.contributes.commands).toEqual([]);
      expect(r.data.contributes.modes).toEqual([]);
      expect(r.data.contributes.templates).toEqual([]);
      expect(r.data.contributes.hooks).toEqual([]);
      expect(r.data.deps).toEqual({});
    }
  });

  it('round-trips a fully populated manifest', () => {
    const populated = {
      ...(validManifest() as Record<string, unknown>),
      homepage: 'https://example.com/x',
      repository: 'https://github.com/u/r',
      contributes: {
        skills: [{ name: 'mega-refactor-helper', description: 'Helper skill for mega refactors.' }],
        commands: [{ name: 'manta:mega-refactor', description: 'Trigger mega refactor.' }],
        modes: [validMode()],
        templates: [{ name: 'mega-refactor.md', description: 'Template for mega refactors.' }],
        hooks: [
          {
            event: 'PreToolUse',
            script: 'hooks/pre.sh',
            requiresApproval: true,
          },
        ],
      },
      deps: { '@manta-library/another': '^1.0.0' },
      integrity: {
        contentHash: 'sha256-abcDEF123==',
        publishedAt: '2026-05-28T11:40:00.000Z',
      },
    };
    const r = MantaPackageManifestSchema.safeParse(populated);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.contributes.modes.length).toBe(1);
      expect(r.data.contributes.hooks[0].requiresApproval).toBe(true);
    }
  });

  it('rejects missing schemaVersion with path ["schemaVersion"]', () => {
    const m = validManifest() as Record<string, unknown>;
    delete m.schemaVersion;
    const r = MantaPackageManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path[0] === 'schemaVersion')).toBe(true);
    }
  });

  it('rejects unknown schemaVersion: 2 (hard-fail policy)', () => {
    const r = MantaPackageManifestSchema.safeParse({ ...(validManifest() as object), schemaVersion: 2 });
    expect(r.success).toBe(false);
  });

  it('rejects uppercase letters in name', () => {
    const r = MantaPackageManifestSchema.safeParse({ ...(validManifest() as object), name: 'Foo' });
    expect(r.success).toBe(false);
  });

  it('rejects a scoped name with uppercase letters', () => {
    const r = MantaPackageManifestSchema.safeParse({ ...(validManifest() as object), name: '@manta-library/RefactorPack' });
    expect(r.success).toBe(false);
  });

  it('rejects non-semver version "1.0"', () => {
    const r = MantaPackageManifestSchema.safeParse({ ...(validManifest() as object), version: '1.0' });
    expect(r.success).toBe(false);
  });

  it('rejects a non-SPDX license enum value', () => {
    const r = MantaPackageManifestSchema.safeParse({ ...(validManifest() as object), license: 'ProprietaryStuff' });
    expect(r.success).toBe(false);
  });

  it('rejects a hook with requiresApproval=false (hard-coded true)', () => {
    const m = {
      ...(validManifest() as object),
      contributes: {
        hooks: [{ event: 'PreToolUse', script: 'x.sh', requiresApproval: false }],
      },
    };
    const r = MantaPackageManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
  });

  it('rejects unknown top-level fields (.strict)', () => {
    const r = MantaPackageManifestSchema.safeParse({ ...(validManifest() as object), bogus: 'field' });
    expect(r.success).toBe(false);
  });

  it('rejects a description shorter than 10 characters', () => {
    const r = MantaPackageManifestSchema.safeParse({ ...(validManifest() as object), description: 'short' });
    expect(r.success).toBe(false);
  });

  it('rejects a description longer than 280 characters', () => {
    const r = MantaPackageManifestSchema.safeParse({
      ...(validManifest() as object),
      description: 'x'.repeat(281),
    });
    expect(r.success).toBe(false);
  });

  it('rejects a bad mantaVersionCompat string', () => {
    const r = MantaPackageManifestSchema.safeParse({ ...(validManifest() as object), mantaVersionCompat: 'not a range' });
    expect(r.success).toBe(false);
  });

  it('rejects a homepage that is not a URL', () => {
    const r = MantaPackageManifestSchema.safeParse({ ...(validManifest() as object), homepage: 'not-a-url' });
    expect(r.success).toBe(false);
  });

  it('rejects contributes.modes entry with unknown basedOn', () => {
    const m = {
      ...(validManifest() as object),
      contributes: {
        modes: [{ ...(validMode() as object), basedOn: 'unknown-mode' }],
      },
    };
    const r = MantaPackageManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
  });

  it('rejects integrity.contentHash without sha256- prefix', () => {
    const r = MantaPackageManifestSchema.safeParse({
      ...(validManifest() as object),
      integrity: { contentHash: 'sha1-foo', publishedAt: '2026-05-28T11:40:00.000Z' },
    });
    expect(r.success).toBe(false);
  });

  it('exposes a usable inferred type MantaPackageManifest', () => {
    const r = MantaPackageManifestSchema.parse(validManifest());
    const typed: MantaPackageManifest = r;
    expect(typed.schemaVersion).toBe(1);
  });
});

describe('LibraryModeJsonSchema', () => {
  it('parses a valid mode.json', () => {
    const r = LibraryModeJsonSchema.safeParse(validMode());
    expect(r.success).toBe(true);
  });

  it('rejects unknown basedOn value', () => {
    const r = LibraryModeJsonSchema.safeParse({ ...(validMode() as object), basedOn: 'unknown-mode' });
    expect(r.success).toBe(false);
  });

  it('rejects unknown fields (.strict)', () => {
    const r = LibraryModeJsonSchema.safeParse({ ...(validMode() as object), unknownField: 1 });
    expect(r.success).toBe(false);
  });

  it('rejects cloneCount with min > max', () => {
    const r = LibraryModeJsonSchema.safeParse({ ...(validMode() as object), cloneCount: { min: 5, max: 2 } });
    expect(r.success).toBe(false);
  });

  it('accepts optional capabilityProfile + primingBlock fields', () => {
    const r = LibraryModeJsonSchema.safeParse({
      ...(validMode() as object),
      capabilityProfile: 'restricted',
      primingBlock: 'extra preamble text',
    });
    expect(r.success).toBe(true);
  });

  it('rejects invalid sessionMode', () => {
    const r = LibraryModeJsonSchema.safeParse({ ...(validMode() as object), sessionMode: 'forever' });
    expect(r.success).toBe(false);
  });

  it('exposes a usable inferred type LibraryModeJson', () => {
    const r = LibraryModeJsonSchema.parse(validMode());
    const typed: LibraryModeJson = r;
    expect(typed.basedOn).toBe('pair-programming');
  });
});
