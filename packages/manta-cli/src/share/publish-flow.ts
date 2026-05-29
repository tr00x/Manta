import * as fs from 'node:fs/promises';
import type { SharedBundleManifest } from '@manta/skill-validator';
import { scanBundleJs } from './static-scanner.js';
import { verifyBundleChecksums } from './bundle-assembler.js';

/**
 * npm publish-flow with MVTS-7 gates (Phase 7b Task 3.2).
 *
 * The gated path to npm. Gates run in a FIXED order, each short-circuiting the
 * rest on failure:
 *   1. static scan clean   (no `blocked` finding in bundled JS)
 *   2. checksum re-verify   (`verifyBundleChecksums` over the unpacked tree)
 *   3. npm login            (`whoami` — null = not logged in)
 *   4. scope ownership      (publisher can publish under `@<scope>`)
 *   5. two human confirms   (publish? + PUBLIC/PERMANENT acknowledgement)
 *   6. size cap             (refuse oversize tarball — packaging-mistake guard)
 *   7. publish              (`npm publish --access public`)
 *
 * Every shell-out is behind an injected `PublishRunner` seam (mirrors Phase 7a's
 * `NetworkRunner`) so tests never touch the network. Publishing is NEVER
 * trigger-fired — `--publish` requires interactive confirmation, enforced one
 * layer up (the CLI guard + the command-layer refusal). This module is the
 * mechanism; the trust boundary is the caller's.
 */

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export interface PublishRunner {
  /** `npm whoami` → the logged-in user, or null if not logged in. */
  whoami(): Promise<string | null>;
  /** Packages the publisher may publish under `scope` (npm access ls-packages / org ls). */
  listScopePackages(scope: string): Promise<string[]>;
  /** `npm publish <tarball> --access public`. */
  publish(tarballPath: string, opts: { access: 'public' }): Promise<void>;
}

export interface Confirmer {
  confirm(prompt: string): Promise<boolean>;
}

export interface PublishOptions {
  tarballPath: string;
  unpackedDir: string;
  manifest: SharedBundleManifest;
  bundleJsFiles: Array<{ relPath: string; content: string }>;
  /** Refuse if the tarball exceeds this many bytes. Default 5 MB. */
  maxBytes?: number;
  runner: PublishRunner;
  confirmer: Confirmer;
}

export type PublishFailureReason =
  | 'scan_blocked'
  | 'checksum_mismatch'
  | 'not_logged_in'
  | 'scope_not_owned'
  | 'declined'
  | 'too_large';

export type PublishResult =
  | { ok: true; published: string }
  | { ok: false; reason: PublishFailureReason; detail: string };

/** Extract the `@scope` (without the `@`) from a package name, or null if unscoped. */
function scopeOf(name: string): string | null {
  if (!name.startsWith('@')) return null;
  const slash = name.indexOf('/');
  if (slash < 0) return null;
  return name.slice(1, slash);
}

export async function publishBundle(opts: PublishOptions): Promise<PublishResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const nameVersion = `${opts.manifest.name}@${opts.manifest.version}`;

  // Gate 1 — static malicious-pattern scan. Any `block` finding refuses.
  const scan = scanBundleJs(opts.bundleJsFiles);
  if (scan.blocked.length > 0) {
    const detail = scan.blocked
      .map((f) => `${f.rule} @ ${f.file}:${f.line}`)
      .join(', ');
    return { ok: false, reason: 'scan_blocked', detail };
  }

  // Gate 2 — checksum re-verify (catches post-assembly tampering/corruption).
  const checksum = await verifyBundleChecksums(opts.unpackedDir);
  if (!checksum.ok) {
    return { ok: false, reason: 'checksum_mismatch', detail: checksum.mismatches.join(', ') };
  }

  // Gate 3 — npm login.
  const who = await opts.runner.whoami();
  if (who === null) {
    return { ok: false, reason: 'not_logged_in', detail: 'run `npm login` first' };
  }

  // Gate 4 — scope ownership. A scoped package requires publish rights under
  // its scope; an empty ownership list means the publisher cannot publish there.
  const scope = scopeOf(opts.manifest.name);
  if (scope !== null) {
    const owned = await opts.runner.listScopePackages(scope);
    if (owned.length === 0) {
      return {
        ok: false,
        reason: 'scope_not_owned',
        detail: `@${scope} is not owned by ${who}; you cannot publish under this scope`,
      };
    }
  }

  // Gate 5 — two interactive human confirmations (informed consent, §0).
  const ok1 = await opts.confirmer.confirm(`Publish ${nameVersion} to npm as ${who}?`);
  if (!ok1) return { ok: false, reason: 'declined', detail: 'first confirmation declined' };
  const ok2 = await opts.confirmer.confirm(
    'This is PUBLIC and PERMANENT — npm does not allow unpublish after 72h. Confirm?',
  );
  if (!ok2) return { ok: false, reason: 'declined', detail: 'second confirmation declined' };

  // Gate 6 — size cap (oversize signals a packaging mistake).
  const stat = await fs.stat(opts.tarballPath);
  if (stat.size > maxBytes) {
    return {
      ok: false,
      reason: 'too_large',
      detail: `tarball is ${stat.size} bytes; cap is ${maxBytes}`,
    };
  }

  // Gate 7 — publish.
  await opts.runner.publish(opts.tarballPath, { access: 'public' });
  return { ok: true, published: nameVersion };
}
