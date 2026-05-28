import type { Mode } from '@manta/snapshot';

export interface LibraryModeEntry {
  /** Library mode name, e.g. "mega-refactor" — must match manifest.contributes.modes[].name. */
  readonly name: string;
  /** Built-in host dispatcher this library mode parameterises. */
  readonly basedOn: Mode;
  /** Owning package: scoped or bare name from the manifest. */
  readonly packageName: string;
  /** Pinned version from the lockfile entry. */
  readonly packageVersion: string;
}

export interface ModeRegistrySnapshot {
  readonly builtins: ReadonlySet<Mode>;
  readonly library: ReadonlyMap<string, LibraryModeEntry>;
}

export type ModeConflictCode = 'mode_conflict_builtin' | 'mode_conflict_library';

export class ModeConflictError extends Error {
  readonly code: ModeConflictCode;
  readonly conflictingName: string;
  readonly existingOwner?: string;

  constructor(opts: { code: ModeConflictCode; conflictingName: string; existingOwner?: string; message: string }) {
    super(opts.message);
    this.name = 'ModeConflictError';
    this.code = opts.code;
    this.conflictingName = opts.conflictingName;
    this.existingOwner = opts.existingOwner;
  }
}

export const BUILTIN_MODES: ReadonlySet<Mode> = new Set<Mode>([
  'recon-swarm',
  'forking-realities',
  'bug-hunt',
  'refactor-wave',
  'pair-programming',
  'test-storm',
  'documentation-chase',
]);

export class ModeRegistry {
  private readonly builtins: ReadonlySet<Mode>;
  private readonly library: Map<string, LibraryModeEntry>;

  constructor(builtins: ReadonlySet<Mode>) {
    this.builtins = new Set(builtins);
    this.library = new Map();
  }

  /** Returns true for built-in modes AND for library-mode names. */
  has(name: string): boolean {
    return this.builtins.has(name as Mode) || this.library.has(name);
  }

  /** Resolve a library mode by name. Returns undefined for built-ins and unknowns. */
  resolveLibrary(name: string): LibraryModeEntry | undefined {
    return this.library.get(name);
  }

  /** Add a library mode. Throws ModeConflictError on collision. */
  registerLibrary(entry: LibraryModeEntry): void {
    if (this.builtins.has(entry.name as Mode)) {
      throw new ModeConflictError({
        code: 'mode_conflict_builtin',
        conflictingName: entry.name,
        message: `library mode "${entry.name}" collides with built-in mode of the same name; library mode names must not shadow built-ins`,
      });
    }
    const existing = this.library.get(entry.name);
    if (existing) {
      throw new ModeConflictError({
        code: 'mode_conflict_library',
        conflictingName: entry.name,
        existingOwner: existing.packageName,
        message: `library mode "${entry.name}" already registered by "${existing.packageName}@${existing.packageVersion}"; uninstall the other package first`,
      });
    }
    this.library.set(entry.name, { ...entry });
  }

  /** Remove a library mode. No-op for unknown names. */
  unregisterLibrary(name: string): void {
    this.library.delete(name);
  }

  /** All registered names. */
  list(): { builtins: Mode[]; library: LibraryModeEntry[] } {
    return {
      builtins: Array.from(this.builtins),
      library: Array.from(this.library.values()),
    };
  }

  /** Immutable point-in-time view for tests and per-cast capture. */
  snapshot(): ModeRegistrySnapshot {
    return {
      builtins: new Set(this.builtins),
      library: new Map(Array.from(this.library, ([k, v]) => [k, { ...v }])),
    };
  }
}

/** Factory: build a registry seeded with the canonical Manta built-in modes. */
export function createDefaultModeRegistry(): ModeRegistry {
  return new ModeRegistry(BUILTIN_MODES);
}
