import type { SanitizationWarning } from './types.js';
import { scanForSecrets } from './secret-scanner.js';
import { ShareSanitizationError } from './errors.js';

/**
 * Sanitize the winning clone's worktree diff for bundling (Phase 7b Task 1.7).
 *
 * The diff (`git diff <merge-base>..<winning-branch>`) is the actual code
 * change — its inherent risk is hardcoded credentials. Rule (research §1.4):
 * a secret-format match anywhere in the diff is a HARD BLOCK
 * (`secret_in_worktree_diff`). No path relativisation — diff hunks are
 * repo-relative by construction. A clean diff passes through verbatim.
 */
export function sanitizeWorktreeDiff(diff: string): {
  sanitized: string;
  warnings: SanitizationWarning[];
} {
  const findings = scanForSecrets(diff);
  if (findings.length > 0) {
    throw new ShareSanitizationError('secret_in_worktree_diff', { findings });
  }
  return { sanitized: diff, warnings: [] };
}
