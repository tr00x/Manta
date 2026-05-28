import semver from 'semver';
import type { Lockfile } from './lockfile.js';

export type CompatResult =
  | { ok: true }
  | {
      ok: false;
      offendingPackage: string;
      offendingPackageRange: string;
      currentVersion: string;
    };

/**
 * Verify every lockfile entry's `mantaVersionCompat` against the current CLI
 * version. Returns the first failing package; callers should surface it with
 * the multi-recovery-option message helper.
 */
export function verifyMantaVersionCompat(
  lock: Lockfile | null,
  mantaCliVersion: string,
): CompatResult {
  if (!lock) return { ok: true };
  for (const [packageName, entry] of Object.entries(lock.packages)) {
    if (!semver.satisfies(mantaCliVersion, entry.mantaVersionCompat, { includePrerelease: true })) {
      return {
        ok: false,
        offendingPackage: packageName,
        offendingPackageRange: entry.mantaVersionCompat,
        currentVersion: mantaCliVersion,
      };
    }
  }
  return { ok: true };
}

/** Validate a single mantaVersionCompat range against a CLI version. */
export function isMantaVersionCompatible(range: string, mantaCliVersion: string): boolean {
  return semver.satisfies(mantaCliVersion, range, { includePrerelease: true });
}

export interface CompatRecoveryContext {
  offendingPackage: string;
  offendingPackageRange: string;
  currentVersion: string;
}

export function buildCompatErrorMessage(ctx: CompatRecoveryContext): string {
  const lines = [
    `Package ${ctx.offendingPackage} requires Manta ${ctx.offendingPackageRange}; you have ${ctx.currentVersion}.`,
    '',
    'Recovery options:',
    `  1) Upgrade the Manta CLI to a version satisfying ${ctx.offendingPackageRange}.`,
    `  2) Install an older ${ctx.offendingPackage} satisfying ${ctx.currentVersion}.`,
    `  3) Uninstall ${ctx.offendingPackage} via \`manta uninstall ${ctx.offendingPackage}\`.`,
  ];
  return lines.join('\n');
}
