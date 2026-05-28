import * as fs from 'node:fs/promises';
import type { BusContext } from '@manta/bus';
import type { LockfileStore } from '../library/lockfile.js';
import type { LocalStore } from '../library/local-store.js';

export type UninstallErrorCode =
  | 'uninstall_spec_parse_failed'
  | 'uninstall_not_installed'
  | 'uninstall_ambiguous'
  | 'uninstall_in_use';

const EXIT_CODES: Record<UninstallErrorCode, number> = {
  uninstall_spec_parse_failed: 11,
  uninstall_not_installed: 12,
  uninstall_ambiguous: 18,
  uninstall_in_use: 18,
};

export class UninstallError extends Error {
  readonly code: UninstallErrorCode;
  readonly exitCode: number;
  readonly details: Record<string, unknown>;
  constructor(
    code: UninstallErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'UninstallError';
    this.code = code;
    this.exitCode = EXIT_CODES[code];
    this.details = details;
  }
}

export interface UninstallRuntime {
  readonly repoRoot: string;
  readonly lockfile: LockfileStore;
  readonly localStore: LocalStore;
  readonly ctx: BusContext;
}

export interface RunUninstallCommandOptions {
  /** `@manta-library/foo` or `@manta-library/foo@1.3.0`. */
  spec: string;
  /**
   * Override the in-use check when matched clones are in soft non-DEAD states
   * ({IDLE, WAITING_FOR_TASK, WINDING_DOWN}). Hot states
   * ({STARTING, WORKING, BLOCKED}) reject even with --force — uninstalling
   * files mid-read by a live `claude --print` subprocess corrupts the cast.
   */
  force?: boolean;
}

export interface RunUninstallCommandResult {
  removedPackageName: string;
  removedVersion: string;
  removedPath: string;
}

/**
 * Six non-DEAD lifecycle states a clone can be in. DEAD is excluded — a DEAD
 * clone holds no live file handle and cannot be corrupted by file removal.
 */
const SOFT_STATES: ReadonlySet<string> = new Set(['IDLE', 'WAITING_FOR_TASK', 'WINDING_DOWN']);
const HOT_STATES: ReadonlySet<string> = new Set(['STARTING', 'WORKING', 'BLOCKED']);

function parseSpec(spec: string): { packageName: string; version: string | undefined } {
  if (typeof spec !== 'string' || spec.length === 0) {
    throw new UninstallError('uninstall_spec_parse_failed', `empty uninstall spec`, { spec });
  }
  // Scoped packages: @scope/name[@version]. The `@` between scope and name is
  // significant; the version separator (if any) is the *second* `@`.
  if (spec.startsWith('@')) {
    const versionAt = spec.indexOf('@', 1);
    if (versionAt < 0) {
      return { packageName: spec, version: undefined };
    }
    return {
      packageName: spec.slice(0, versionAt),
      version: spec.slice(versionAt + 1) || undefined,
    };
  }
  // Bare names: name[@version].
  const at = spec.indexOf('@');
  if (at < 0) {
    return { packageName: spec, version: undefined };
  }
  return {
    packageName: spec.slice(0, at),
    version: spec.slice(at + 1) || undefined,
  };
}

interface InUseMatch {
  cloneId: string;
  state: string;
  castId: string;
  mode: string;
}

function findInUseMatches(
  clones: Array<Record<string, unknown>>,
  packageModes: ReadonlySet<string>,
): InUseMatch[] {
  const matches: InUseMatch[] = [];
  for (const c of clones) {
    const state = typeof c.state === 'string' ? c.state : '';
    if (state === 'DEAD' || state === '') continue;
    const mode = typeof c.mode === 'string' ? c.mode : '';
    if (!packageModes.has(mode)) continue;
    const cloneId = typeof c.clone_id === 'string' ? c.clone_id : '<unknown>';
    const meta = (c.metadata ?? {}) as Record<string, unknown>;
    const castId = typeof meta.cast_id === 'string' ? meta.cast_id : '<unknown>';
    matches.push({ cloneId, state, castId, mode });
  }
  return matches;
}

export async function runUninstallCommand(
  rt: UninstallRuntime,
  opts: RunUninstallCommandOptions,
): Promise<RunUninstallCommandResult> {
  const { packageName, version: requestedVersion } = parseSpec(opts.spec);

  // Step 1: resolve version from the index.
  const index = await rt.localStore.readIndex();
  const matchingInstalls = index.installs.filter((e) => e.packageName === packageName);
  if (matchingInstalls.length === 0) {
    throw new UninstallError(
      'uninstall_not_installed',
      `${packageName} is not installed`,
      { packageName },
    );
  }

  let entry;
  if (requestedVersion !== undefined) {
    const found = matchingInstalls.find((e) => e.version === requestedVersion);
    if (!found) {
      const available = matchingInstalls.map((e) => e.version).sort();
      throw new UninstallError(
        'uninstall_not_installed',
        `${packageName}@${requestedVersion} is not installed. Available: ${available.join(', ')}.`,
        { packageName, requestedVersion, available },
      );
    }
    entry = found;
  } else if (matchingInstalls.length > 1) {
    const versions = matchingInstalls.map((e) => e.version).sort();
    throw new UninstallError(
      'uninstall_ambiguous',
      `multiple versions of ${packageName} installed: ${versions.join(', ')}. Specify one.`,
      { packageName, versions },
    );
  } else {
    entry = matchingInstalls[0]!;
  }

  // Step 2: in-use check.
  const packageModes = new Set(entry.contributes.modes);
  let inUse: InUseMatch[] = [];
  if (packageModes.size > 0) {
    const clones = (await rt.ctx.registry.list()) as unknown as Array<Record<string, unknown>>;
    inUse = findInUseMatches(clones, packageModes);
  }
  if (inUse.length > 0) {
    const hot = inUse.filter((m) => HOT_STATES.has(m.state));
    const soft = inUse.filter((m) => SOFT_STATES.has(m.state));
    const allSoft = inUse.every((m) => SOFT_STATES.has(m.state));
    const castIds = Array.from(new Set(inUse.map((m) => m.castId))).join(',');
    const cloneIds = inUse.map((m) => m.cloneId).join(',');
    const modes = Array.from(new Set(inUse.map((m) => m.mode))).join(',');

    if (!opts.force) {
      throw new UninstallError(
        'uninstall_in_use',
        `${packageName}@${entry.version} is in use by cast ${castIds} (clones: ${cloneIds}; modes: ${modes}). Run \`manta abort ${castIds}\` first.`,
        { packageName, version: entry.version, hot, soft, castIds, cloneIds },
      );
    }
    if (!allSoft) {
      const hotCloneIds = hot.map((m) => m.cloneId).join(',');
      const hotStates = Array.from(new Set(hot.map((m) => m.state))).join(',');
      throw new UninstallError(
        'uninstall_in_use',
        `uninstall --force: refusing while clones ${hotCloneIds} are ${hotStates}. Run \`manta abort ${castIds}\` first.`,
        { packageName, version: entry.version, hot, castIds, cloneIds },
      );
    }
    // All matched clones are in soft states — --force allowed.
    process.stderr.write(
      `[manta] uninstall: --force overriding in-use check for ${packageName}@${entry.version} (soft clones: ${cloneIds})\n`,
    );
  }

  // Step 3: remove the install dir.
  const installPath = rt.localStore.pathFor(packageName, entry.version);
  await fs.rm(installPath, { recursive: true, force: true });

  // Step 4: drop the index entry.
  await rt.localStore.removeIndexEntry(packageName, entry.version);

  // Step 5: drop the lockfile entry (if present).
  const currentLock = await rt.lockfile.read();
  if (currentLock !== null && currentLock.packages[packageName] !== undefined) {
    await rt.lockfile.mutate((current) => {
      if (current === null) {
        // Race: another writer cleared the lockfile between read and mutate.
        // Materialise an empty lockfile and return it verbatim — drop done.
        return {
          schemaVersion: 1 as const,
          mantaVersion: currentLock.mantaVersion,
          generatedAt: new Date().toISOString(),
          packages: {},
        };
      }
      const next = { ...current, packages: { ...current.packages } };
      delete next.packages[packageName];
      next.generatedAt = new Date().toISOString();
      return next;
    });
  }

  return {
    removedPackageName: packageName,
    removedVersion: entry.version,
    removedPath: installPath,
  };
}
