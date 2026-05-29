import type { SanitizationWarning } from './types.js';
import { scanForSecrets } from './secret-scanner.js';
import { ShareSanitizationError } from './errors.js';
import { findAbsolutePaths } from './path-scan.js';

const P_CREATED_AT = 'created_at: ';

/**
 * Sanitize an on-disk ZK note for bundling (Phase 7b Task 1.6).
 *
 * ZK notes (docs/zk/<slug>-<id>.md, written by fsMemoryWriters.zkWrite) carry
 * frontmatter (id/title/clone_id/created_at/tags) + free-form prose. Rules
 * (research §1.4):
 *  - `created_at` (epoch ms) → rewritten to the bundle's `bundledAt` ISO
 *    (drops a correlatable wallclock; only the FIRST frontmatter occurrence).
 *  - title + body secret-format match → FATAL (throws secret_in_zk_note).
 *  - absolute paths in the prose → WARN, masked, NO auto-redact (the path may
 *    be inseparable from the surrounding sentence; the author accepts before
 *    publish). id / clone_id / tags / title are preserved.
 */
export function sanitizeZkNote(
  markdown: string,
  opts: { repoRoot: string; bundledAt: string },
): { sanitized: string; warnings: SanitizationWarning[] } {
  // Secret scan over the WHOLE note (covers title frontmatter + heading + body).
  const findings = scanForSecrets(markdown);
  if (findings.length > 0) {
    throw new ShareSanitizationError('secret_in_zk_note', { findings });
  }

  // Rewrite only the first `created_at:` frontmatter line (idempotent if the
  // body happens to contain the literal text — frontmatter is at the top).
  let rewroteCreatedAt = false;
  const sanitized = markdown
    .split('\n')
    .map((line) => {
      if (!rewroteCreatedAt && line.startsWith(P_CREATED_AT)) {
        rewroteCreatedAt = true;
        return `${P_CREATED_AT}${opts.bundledAt}`;
      }
      return line;
    })
    .join('\n');

  const warnings: SanitizationWarning[] = [];
  for (const p of findAbsolutePaths(sanitized, opts.repoRoot)) {
    warnings.push({
      rule: 'zk.body.path',
      source: 'zk note body',
      message: 'found an absolute path in the note (not auto-redacted — accept before publish)',
      severity: 'warning',
      maskedMatch: `${p.slice(0, 4)}…`,
    });
  }

  return { sanitized, warnings };
}
