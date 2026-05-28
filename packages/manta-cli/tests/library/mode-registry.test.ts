import { describe, it, expect } from 'vitest';
import type { Mode } from '@manta/snapshot';
import {
  ModeRegistry,
  ModeConflictError,
  createDefaultModeRegistry,
  type LibraryModeEntry,
} from '../../src/library/mode-registry.js';

const BUILTINS: ReadonlySet<Mode> = new Set<Mode>([
  'recon-swarm',
  'forking-realities',
  'bug-hunt',
  'refactor-wave',
  'pair-programming',
  'test-storm',
  'documentation-chase',
]);

const megaRefactor = (): LibraryModeEntry => ({
  name: 'mega-refactor',
  basedOn: 'pair-programming',
  packageName: '@manta-library/refactor-megapack',
  packageVersion: '1.3.0',
});

describe('ModeRegistry', () => {
  it('has() returns true for a built-in mode', () => {
    const r = new ModeRegistry(BUILTINS);
    expect(r.has('recon-swarm')).toBe(true);
  });

  it('has() returns false for a library mode before registration, true after', () => {
    const r = new ModeRegistry(BUILTINS);
    expect(r.has('mega-refactor')).toBe(false);
    r.registerLibrary(megaRefactor());
    expect(r.has('mega-refactor')).toBe(true);
  });

  it('registerLibrary throws ModeConflictError when a library mode shadows a built-in', () => {
    const r = new ModeRegistry(BUILTINS);
    expect(() =>
      r.registerLibrary({
        name: 'recon-swarm',
        basedOn: 'recon-swarm',
        packageName: '@manta-library/sneaky',
        packageVersion: '0.1.0',
      }),
    ).toThrow(ModeConflictError);
    try {
      r.registerLibrary({
        name: 'recon-swarm',
        basedOn: 'recon-swarm',
        packageName: '@manta-library/sneaky',
        packageVersion: '0.1.0',
      });
    } catch (err) {
      expect(err).toBeInstanceOf(ModeConflictError);
      expect((err as ModeConflictError).code).toBe('mode_conflict_builtin');
      expect((err as ModeConflictError).conflictingName).toBe('recon-swarm');
    }
  });

  it('registerLibrary throws ModeConflictError when two library entries collide on name', () => {
    const r = new ModeRegistry(BUILTINS);
    r.registerLibrary(megaRefactor());
    try {
      r.registerLibrary({
        ...megaRefactor(),
        packageName: '@manta-library/another-pack',
      });
      throw new Error('expected ModeConflictError');
    } catch (err) {
      expect(err).toBeInstanceOf(ModeConflictError);
      expect((err as ModeConflictError).code).toBe('mode_conflict_library');
      expect((err as ModeConflictError).existingOwner).toBe('@manta-library/refactor-megapack');
    }
  });

  it('list() reports the seven built-ins', () => {
    const r = new ModeRegistry(BUILTINS);
    const list = r.list();
    expect(list.builtins).toHaveLength(7);
    expect(list.builtins.sort()).toEqual(
      [
        'bug-hunt',
        'documentation-chase',
        'forking-realities',
        'pair-programming',
        'recon-swarm',
        'refactor-wave',
        'test-storm',
      ],
    );
    expect(list.library).toEqual([]);
  });

  it('list() includes registered library entries', () => {
    const r = new ModeRegistry(BUILTINS);
    r.registerLibrary(megaRefactor());
    const list = r.list();
    expect(list.library).toHaveLength(1);
    expect(list.library[0]!.name).toBe('mega-refactor');
  });

  it('resolveLibrary returns the entry for a library mode', () => {
    const r = new ModeRegistry(BUILTINS);
    r.registerLibrary(megaRefactor());
    const entry = r.resolveLibrary('mega-refactor');
    expect(entry?.basedOn).toBe('pair-programming');
    expect(entry?.packageName).toBe('@manta-library/refactor-megapack');
  });

  it('resolveLibrary returns undefined for a built-in even when has() returns true', () => {
    const r = new ModeRegistry(BUILTINS);
    expect(r.has('recon-swarm')).toBe(true);
    expect(r.resolveLibrary('recon-swarm')).toBeUndefined();
  });

  it('resolveLibrary returns undefined for an unknown mode', () => {
    const r = new ModeRegistry(BUILTINS);
    expect(r.resolveLibrary('nope')).toBeUndefined();
  });

  it('unregisterLibrary removes a library mode and makes has() false again', () => {
    const r = new ModeRegistry(BUILTINS);
    r.registerLibrary(megaRefactor());
    expect(r.has('mega-refactor')).toBe(true);
    r.unregisterLibrary('mega-refactor');
    expect(r.has('mega-refactor')).toBe(false);
    expect(r.resolveLibrary('mega-refactor')).toBeUndefined();
  });

  it('unregisterLibrary is a no-op for an unknown library name', () => {
    const r = new ModeRegistry(BUILTINS);
    expect(() => r.unregisterLibrary('nope')).not.toThrow();
  });

  it('snapshot() returns an isolated read of the registry state', () => {
    const r = new ModeRegistry(BUILTINS);
    r.registerLibrary(megaRefactor());
    const snap = r.snapshot();
    expect(snap.builtins.has('recon-swarm')).toBe(true);
    expect(snap.library.get('mega-refactor')?.packageName).toBe('@manta-library/refactor-megapack');
    // Mutations after snapshot don't bleed retroactively.
    r.unregisterLibrary('mega-refactor');
    expect(snap.library.get('mega-refactor')).toBeDefined();
  });

  it('createDefaultModeRegistry seeds all seven built-ins', () => {
    const r = createDefaultModeRegistry();
    expect(r.list().builtins).toHaveLength(7);
    expect(r.has('recon-swarm')).toBe(true);
    expect(r.has('forking-realities')).toBe(true);
  });
});
