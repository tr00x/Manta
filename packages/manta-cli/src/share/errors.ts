import type { SecretFinding } from './secret-scanner.js';

/**
 * Fail-closed error thrown by a sanitizer when a HARD-BLOCK rule fires (a
 * secret-format match in task text, approach hint, ZK note, post-mortem body,
 * or worktree diff). The `manta share` command never bundles past this — there
 * is no `--accept` for secrets (§0: secrets are fatal, not warnings).
 *
 * `code` is a stable machine label (`secret_in_task_contract`,
 * `secret_in_worktree_diff`, `secret_in_zk_note`, `secret_in_post_mortem`);
 * `details.findings` carries the MASKED findings only — never the raw token.
 */
export class ShareSanitizationError extends Error {
  readonly code: string;
  readonly details: { findings: SecretFinding[] };

  constructor(code: string, details: { findings: SecretFinding[] }) {
    super(`share sanitization refused the bundle: ${code} (${details.findings.length} finding(s))`);
    this.name = 'ShareSanitizationError';
    this.code = code;
    this.details = details;
  }
}
