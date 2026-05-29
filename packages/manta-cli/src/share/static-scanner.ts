/**
 * Static malicious-pattern scanner for bundled JS (Phase 7b Task 3.1,
 * research §2 mitigation d).
 *
 * Phase 7b modes are `basedOn` built-ins and ship NO JS, so this scanner
 * usually finds nothing — but it ships now for forward-compat (a community
 * fork that bundles a built dispatcher), and runs at publish time (and later
 * at install/preview time). It returns `{ blocked, warnings }`; the publish
 * flow short-circuits on any `blocked` finding.
 *
 * v1 is a line-oriented REGEX pass. It is cheap and defeated by obfuscation —
 * this is documented and accepted (§0: best-effort, not a security boundary).
 * AST analysis via `acorn` is a Phase 8 hardening. The honest message is the
 * same as the rest of the trust model: a Manta bundle is a user-vetted dev
 * tool, like an `npx` script — review it, install only from authors you trust.
 */

export type ScanSeverity = 'block' | 'warn';

export interface ScanFinding {
  /** Stable rule id, e.g. "child-process-exec", "eval", "read-sensitive-home". */
  rule: string;
  /** Bundle-relative path of the offending file. */
  file: string;
  /** 1-based line number of the match. */
  line: number;
  severity: ScanSeverity;
  /** The matched line, truncated — never a full file. */
  snippet: string;
}

const SNIPPET_MAX = 160;

/** Only these extensions are scanned; everything else (md, json, …) is skipped. */
const JS_EXT = /\.(?:js|mjs|cjs|jsx|ts|tsx)$/i;

function snippetOf(rawLine: string): string {
  const trimmed = rawLine.trim();
  return trimmed.length > SNIPPET_MAX ? `${trimmed.slice(0, SNIPPET_MAX - 1)}…` : trimmed;
}

/**
 * Heuristic literal check for a call's FIRST argument. Reads the text right
 * after the opening paren up to the first `,` or `)` and asks "does it start
 * with a string literal delimiter?". A literal first arg (`exec("ls")`) is the
 * safer form for spawn/require; a bare identifier (`exec(cmd)`) is non-literal.
 * Best-effort by design — defeated by `exec("" + cmd)`, which §0 accepts.
 */
function firstArgIsLiteral(afterParen: string): boolean {
  const arg = afterParen.replace(/^\s+/, '');
  return arg.startsWith("'") || arg.startsWith('"') || arg.startsWith('`');
}

interface SimpleRule {
  rule: string;
  severity: ScanSeverity;
  pattern: RegExp;
}

/** Rules that fire on a bare pattern match, no argument inspection. */
const SIMPLE_RULES: readonly SimpleRule[] = [
  { rule: 'eval', severity: 'warn', pattern: /\beval\s*\(/ },
  { rule: 'new-function', severity: 'warn', pattern: /\bnew\s+Function\s*\(/ },
  // exec / execSync: BOTH non-literal AND literal-but-undeclared forms block
  // (research §2 rows 3+4 — Phase 7b has no `requiresChildProcess` manifest
  // declaration, so every exec/execSync is a hard block).
  { rule: 'child-process-exec', severity: 'block', pattern: /\b(?:exec|execSync)\s*\(/ },
  // Sensitive home reads (credentials / keys / npm + git auth) → block.
  { rule: 'read-sensitive-home', severity: 'block', pattern: /~\/\.(?:ssh|aws|npmrc|netrc)\b/ },
  // Network egress to an undeclared host → warn (no declaration mechanism in
  // Phase 7b, so any network call is advisory).
  { rule: 'network', severity: 'warn', pattern: /\bfetch\s*\(|\bhttps?\.request\s*\(/ },
];

/** Write to a sensitive target (.git internals, .env, .envrc) → block. */
const WRITE_CALL = /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|rm|rmSync|unlink|unlinkSync)\s*\(/;
const WRITE_TARGET = /\.git\/|['"`][^'"`]*\.envrc?\b|['"`]\.env\b/;

/** `process.env.X` where X looks like a credential. */
const ENV_SECRET = /process\.env\.([A-Za-z0-9_]*(?:API|TOKEN|SECRET|KEY|PASSWORD)[A-Za-z0-9_]*)/;

/** Calls whose finding depends on whether the first arg is a literal. */
const SPAWN_CALL = /\b(?:spawn|spawnSync)\s*\(/;
const REQUIRE_CALL = /\brequire\s*\(/;

function scanLine(file: string, line: number, text: string, out: { blocked: ScanFinding[]; warnings: ScanFinding[] }): void {
  const push = (rule: string, severity: ScanSeverity): void => {
    const finding: ScanFinding = { rule, file, line, severity, snippet: snippetOf(text) };
    (severity === 'block' ? out.blocked : out.warnings).push(finding);
  };

  for (const r of SIMPLE_RULES) {
    if (r.pattern.test(text)) push(r.rule, r.severity);
  }

  if (WRITE_CALL.test(text) && WRITE_TARGET.test(text)) push('write-sensitive-file', 'block');

  if (ENV_SECRET.test(text)) push('env-secret-read', 'warn');

  // spawn / require: only the non-literal first-arg form is flagged.
  const spawnM = SPAWN_CALL.exec(text);
  if (spawnM && !firstArgIsLiteral(text.slice(spawnM.index + spawnM[0].length))) {
    push('child-process-spawn', 'warn');
  }
  const requireM = REQUIRE_CALL.exec(text);
  if (requireM && !firstArgIsLiteral(text.slice(requireM.index + requireM[0].length))) {
    push('dynamic-require', 'warn');
  }
}

/**
 * Scan every JS file in a bundle for malicious patterns. Non-JS files are
 * skipped. Returns block findings (publish-fatal) and warn findings
 * (advisory) separately.
 */
export function scanBundleJs(
  files: Array<{ relPath: string; content: string }>,
): { blocked: ScanFinding[]; warnings: ScanFinding[] } {
  const out: { blocked: ScanFinding[]; warnings: ScanFinding[] } = { blocked: [], warnings: [] };
  for (const f of files) {
    if (!JS_EXT.test(f.relPath)) continue;
    const lines = f.content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      scanLine(f.relPath, i + 1, lines[i] ?? '', out);
    }
  }
  return out;
}
