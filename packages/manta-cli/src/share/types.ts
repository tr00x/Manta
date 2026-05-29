/**
 * Shared types for the `manta share` sanitization pipeline (Phase 7b).
 *
 * Every artifact sanitizer (snapshot, task-contract, post-mortem, ZK note,
 * events, worktree-diff) returns the same shape: the sanitized artifact plus
 * a `SanitizationWarning[]`. The `manta share` command (Chunk 2) aggregates
 * all warnings, renders them, and blocks publish until either resolved or
 * `--accept-warnings` is passed (interactive only). `fatal`-severity findings
 * (secrets) are hard blocks — never accept-able.
 */

export type SanitizationSeverity = 'warning' | 'fatal';

export interface SanitizationWarning {
  /** Stable rule id, e.g. "snapshot.parentWorktree", "zk.body.path". */
  rule: string;
  /** Which artifact + field this came from, for the rendered report. */
  source: string;
  /** Human-readable description of what was found and what was done. */
  message: string;
  severity: SanitizationSeverity;
  /**
   * For path/secret findings: the matched substring, already masked
   * (first 4 chars + "…") so the report itself never re-leaks it.
   */
  maskedMatch?: string;
}
