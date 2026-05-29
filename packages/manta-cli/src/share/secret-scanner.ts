/**
 * Best-effort secret-format scanner for `manta share` bundles (Phase 7b).
 *
 * Used by the task-text, approach-hint, ZK-note, post-mortem, and
 * worktree-diff sanitizers as a HARD BLOCK (research §1.4): a match refuses
 * the bundle. False negatives are acceptable — this is best-effort, NOT a
 * security boundary (§0 trust model). The regex set lives here, in one tested
 * place, so every sanitizer scans identically.
 */

export interface SecretFinding {
  /** Provider label, e.g. "aws-access-key", "openai-anthropic-key", "github-pat". */
  kind: string;
  /** Masked sample (first 4 chars + "…") — never the full token. */
  masked: string;
}

interface SecretRule {
  kind: string;
  pattern: RegExp;
}

/**
 * Secret-format rules (research §1.4 + extended). Every rule is a HARD BLOCK.
 * Patterns are compiled once at module load. The `g` flag lets a single text
 * yield multiple findings of the same kind; the scanner resets `lastIndex`
 * per use so rules are reusable across calls.
 */
const RULES: readonly SecretRule[] = [
  { kind: 'aws-access-key', pattern: /AKIA[0-9A-Z]{16}/g },
  // Code-review must-fix (cast-1780020786877 merge ceremony): the loose
  // `sk-[A-Za-z0-9_-]{20,}` form false-positive'd on benign prose like
  // `sk-learn-version-0.24.1-installation-guide` and tripped a HARD-BLOCK
  // (fatal, no --accept) on share bundles. Tightened to the prefixed forms
  // Anthropic/OpenAI actually issue (`sk-ant-…`, `sk-proj-…`, `sk-live-…`,
  // `sk-test-…`) plus the long alphanumeric form (≥48 chars, no
  // underscores/dashes — too long to occur by accident in identifiers).
  {
    kind: 'openai-anthropic-key',
    pattern: /sk-(?:ant|proj|live|test|or)-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{48,}/g,
  },
  { kind: 'github-pat', pattern: /ghp_[A-Za-z0-9]{36}/g },
  { kind: 'github-fine-grained-pat', pattern: /github_pat_[A-Za-z0-9_]{40,}/g },
  { kind: 'slack-token', pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'google-api-key', pattern: /AIza[0-9A-Za-z_-]{35}/g },
  {
    kind: 'private-key',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
  },
  {
    kind: 'jwt',
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  {
    // JS has no inline (?i); the `i` flag covers the keyword case-insensitivity.
    kind: 'generic-secret-assignment',
    pattern: /(?:api[_-]?key|token|secret|password)\s*[:=]\s*['"]?[A-Za-z0-9_-]{16,}/gi,
  },
];

/** Mask a secret for safe inclusion in a report: keep the first 4 chars. */
export function maskSecret(s: string): string {
  return `${s.slice(0, 4)}…`;
}

/**
 * Scan arbitrary text for common secret formats. Returns every match across
 * every rule (a blob with an AWS key and a GitHub PAT yields two findings).
 */
export function scanForSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const rule of RULES) {
    // Fresh lastIndex per use — RULES regexes are module-level and `g`-flagged.
    rule.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.pattern.exec(text)) !== null) {
      findings.push({ kind: rule.kind, masked: maskSecret(m[0]) });
      // Guard against a zero-width match looping forever (none of our patterns
      // can match empty, but defense-in-depth keeps the loop terminating).
      if (m.index === rule.pattern.lastIndex) rule.pattern.lastIndex++;
    }
  }
  return findings;
}
