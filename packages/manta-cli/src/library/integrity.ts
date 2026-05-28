import * as fs from 'node:fs/promises';
import { computeDirDigest } from './dir-digest.js';
import type { Lockfile } from './lockfile.js';
import type { LocalStore } from './local-store.js';

export type IntegrityVerificationResult =
  | { ok: true }
  | {
      ok: false;
      offendingPackage: string;
      expected: string;
      actual: string;
    };

/**
 * Sentinel `actual` value returned when the on-disk install directory is
 * missing entirely (either never installed, or someone `rm -rf`'d
 * `~/.manta/library/`). Callers surface this distinctly from a content
 * mismatch — the recovery hint is the same shape (`manta install <name>
 * @<version> --force`) but the root cause is different.
 */
export const MISSING_INSTALL_SENTINEL = '<missing>';

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Per-cast hash-pin verification. For every entry in the lockfile, recompute
 * the on-disk directory digest and compare it to the `directoryDigest` field
 * captured at install time. Returns `{ ok: true }` if every package matches,
 * otherwise `{ ok: false, … }` with the **first** mismatched package.
 *
 * Short-circuiting is intentional: a single tampered package is enough to
 * refuse the cast, and the cast.ts call-site surfaces an actionable
 * recovery hint pointing at that one package. Continuing the loop would
 * waste fs walks and produce noisier output for no operational gain.
 *
 * Two distinct failure shapes are surfaced through one return shape so the
 * caller does not need to discriminate:
 *  - Install directory missing → `actual: '<missing>'`.
 *  - Install directory present, content drifted → `actual: 'sha256-…'`.
 *
 * Performance: a typical library package is a few kilobytes of skill
 * markdown + JSON; the cold-disk fs walk completes in single-digit ms.
 * Cost is paid once per `manta cast` invocation.
 *
 * @see {@link computeDirDigest} for the canonical hash transcript.
 * @see {@link verifyMantaVersionCompat} for the sibling preflight that runs
 *      before this one (so compat-broken-AND-tampered installs surface the
 *      upgrade message first, not the tamper message).
 */
export async function verifyLibraryIntegrity(
  lock: Lockfile | null,
  localStore: LocalStore,
): Promise<IntegrityVerificationResult> {
  if (!lock) return { ok: true };
  for (const [packageName, entry] of Object.entries(lock.packages)) {
    const installPath = localStore.pathFor(packageName, entry.version);
    if (!(await pathExists(installPath))) {
      return {
        ok: false,
        offendingPackage: packageName,
        expected: entry.directoryDigest,
        actual: MISSING_INSTALL_SENTINEL,
      };
    }
    const actual = await computeDirDigest(installPath);
    if (actual !== entry.directoryDigest) {
      return {
        ok: false,
        offendingPackage: packageName,
        expected: entry.directoryDigest,
        actual,
      };
    }
  }
  return { ok: true };
}

/**
 * Build the user-facing error message for an integrity failure. Includes the
 * offending package, both digests for diagnostic forensics, and an
 * actionable recovery hint. Separated from the verifier so the cast.ts
 * call-site stays grep-able and the format is asserted in one place.
 */
export interface IntegrityErrorContext {
  offendingPackage: string;
  offendingVersion: string;
  expected: string;
  actual: string;
}

export function buildIntegrityErrorMessage(ctx: IntegrityErrorContext): string {
  const reason =
    ctx.actual === MISSING_INSTALL_SENTINEL
      ? `install directory is missing on disk`
      : `on-disk content hash does not match the lockfile`;
  return [
    `Library package ${ctx.offendingPackage}@${ctx.offendingVersion} failed hash-pin verification: ${reason}.`,
    `  expected: ${ctx.expected}`,
    `  actual:   ${ctx.actual}`,
    '',
    `Run \`manta install ${ctx.offendingPackage}@${ctx.offendingVersion} --force\` to re-fetch.`,
  ].join('\n');
}
