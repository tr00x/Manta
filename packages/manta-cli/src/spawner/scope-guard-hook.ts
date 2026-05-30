import * as path from 'node:path';

/**
 * SECURITY — clone hard-guardrails (audit-v1 H "clone has no hard guardrails").
 *
 * Clones run `claude --permission-mode bypassPermissions`, so the
 * `allowedPaths`/`forbiddenPaths` scope fence is otherwise enforced ONLY as
 * soft priming text the model may ignore under task pressure. This module is
 * the HARD invariant: a PreToolUse hook that runs in the harness (not the
 * model) and denies out-of-scope writes and dangerous Bash ops BEFORE the
 * tool executes. It generalizes the test-storm `git-lock-hook` into an
 * always-on guard installed for every clone (see clone-spawner.ts).
 *
 * `checkScopeGuard` is the authoritative, fs-free decision logic (unit
 * tested). `buildScopeGuardHookScript` bakes a self-contained `.cjs` that
 * mirrors it for the harness — that generated artifact is exercised
 * end-to-end in the test suite so the two paths cannot silently drift.
 */

/**
 * Tools that mutate the filesystem directly (not via Bash). Each carries a
 * target file path in its tool_input that must fall inside the clone's scope.
 * `MultiEdit` and `Edit`/`Write` use `file_path`; `NotebookEdit` uses
 * `notebook_path`.
 */
const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * Files a clone may always write at its worktree ROOT, even when they fall
 * outside `allowedPaths`. `last-gasp-report.md` is mandated by the
 * manta-graceful-death skill — every clone writes it to the worktree root on
 * shutdown; blocking it would make graceful death impossible. Keep this list
 * minimal: it is a hole in the scope fence, justified only by operational
 * necessity.
 */
const ROOT_ALLOWLIST = ['last-gasp-report.md'];

/**
 * `git ... push`, tolerating option clusters between `git` and the
 * subcommand (`git -c k=v push`, `git --git-dir=/p push`). Mirrors the
 * widened pattern from git-lock-hook (bug-hunt MAJOR-2). `\bgit\b` (not
 * `\bgit\s+`) avoids matching `gitignore`.
 */
const GIT_PUSH = /\bgit\b(\s+-\S+(\s+\S+)?)*\s+push\b/;

export interface ScopeGuardContext {
  /** Claude Code tool name (`tool_name` in the PreToolUse frame). */
  tool: string;
  /** Claude Code tool input (`tool_input` in the PreToolUse frame). */
  input: Record<string, unknown>;
  /** Absolute worktree root — the clone's cwd. */
  worktree: string;
  /** Paths the clone may write, relative to the worktree. `.` = whole tree. */
  allowedPaths: readonly string[];
  /** Paths the clone may never write, relative to the worktree. */
  forbiddenPaths: readonly string[];
}

export interface ScopeGuardResult {
  blocked: boolean;
  /** Human + model-facing explanation, surfaced via `permissionDecisionReason`. */
  reason?: string;
}

function isInside(abs: string, root: string): boolean {
  if (abs === root) return true;
  const withSep = root.endsWith(path.sep) ? root : root + path.sep;
  return abs.startsWith(withSep);
}

function resolveTarget(worktree: string, p: string): string {
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(worktree, p);
}

function hasGitSegment(abs: string): boolean {
  return abs.split(path.sep).includes('.git');
}

function stripQuotes(t: string): string {
  if (
    t.length >= 2 &&
    ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

/** Naive shell-ish tokenizer: split on whitespace, respect single/double quotes. */
function tokenize(cmd: string): string[] {
  const m = cmd.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return m.map(stripQuotes);
}

/**
 * Reduce a token to its candidate filesystem path: strip a leading
 * `--opt=` / `-o=` prefix (so `--git-dir=/p` → `/p`) and surrounding quotes.
 * Returns '' for pure flags (`-rf`, `--force`).
 */
function candidatePath(token: string): string {
  let t = token;
  if (t.startsWith('-')) {
    const eq = t.indexOf('=');
    if (eq === -1) return '';
    t = t.slice(eq + 1);
  }
  return stripQuotes(t);
}

function looksPathLike(t: string): boolean {
  return t.includes('/') || t === '.git' || t.startsWith('.git') || t.startsWith('~');
}

/** Decide whether a single write target is in-scope. */
function checkWritePath(
  target: string,
  worktree: string,
  allowedPaths: readonly string[],
  forbiddenPaths: readonly string[],
): ScopeGuardResult {
  const abs = resolveTarget(worktree, target);
  if (!isInside(abs, worktree)) {
    return {
      blocked: true,
      reason: `write outside the clone worktree is forbidden: ${target}`,
    };
  }
  for (const f of forbiddenPaths) {
    if (isInside(abs, resolveTarget(worktree, f))) {
      return {
        blocked: true,
        reason: `write to a forbidden path is blocked: ${target} (matches forbiddenPaths entry "${f}")`,
      };
    }
  }
  // Operational allowlist at the worktree root (graceful-death deliverable).
  for (const name of ROOT_ALLOWLIST) {
    if (abs === path.join(worktree, name)) return { blocked: false };
  }
  const allowsWholeTree = allowedPaths.some(
    (a) => a === '.' || a === './' || resolveTarget(worktree, a) === worktree,
  );
  if (allowsWholeTree) return { blocked: false };
  for (const a of allowedPaths) {
    if (isInside(abs, resolveTarget(worktree, a))) return { blocked: false };
  }
  return {
    blocked: true,
    reason: `write outside allowedPaths is blocked: ${target}. Allowed: ${allowedPaths.join(', ')}.`,
  };
}

/** Block recursive `rm` whose target escapes the worktree or hits a protected path. */
function checkRecursiveRm(
  cmd: string,
  worktree: string,
  forbiddenPaths: readonly string[],
): ScopeGuardResult {
  // Split into sub-commands on shell separators so `... && rm -rf /x` is seen.
  const segments = cmd.split(/&&|\|\||;|\n|\|/);
  for (const seg of segments) {
    const toks = tokenize(seg.trim());
    let i = 0;
    // Skip leading `VAR=val` environment assignments.
    while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i]!)) i++;
    const head = toks[i];
    if (!head) continue;
    if (head.split('/').pop() !== 'rm') continue;
    const args = toks.slice(i + 1);
    let recursive = false;
    const targets: string[] = [];
    for (const a of args) {
      if (a === '--recursive' || a === '-r' || a === '-R') {
        recursive = true;
        continue;
      }
      if (a.startsWith('--')) continue; // other long opt (e.g. --force)
      if (a.startsWith('-') && a.length > 1) {
        if (/[rR]/.test(a)) recursive = true; // short cluster, e.g. -rf / -fr
        continue;
      }
      targets.push(a);
    }
    if (!recursive) continue;
    for (const t of targets) {
      const sq = stripQuotes(t);
      // Unexpanded variable or home-relative target — we cannot prove it stays
      // inside the worktree, so fail safe.
      if (sq.includes('$') || sq.startsWith('~')) {
        return {
          blocked: true,
          reason: `recursive rm with an unresolved or home-relative target is blocked: ${t}`,
        };
      }
      const abs = resolveTarget(worktree, sq);
      if (!isInside(abs, worktree) || abs === worktree) {
        return {
          blocked: true,
          reason: `recursive rm targeting a path outside the clone worktree is forbidden: ${t}`,
        };
      }
      if (hasGitSegment(abs)) {
        return {
          blocked: true,
          reason: `recursive rm targeting a .git directory is forbidden: ${t}`,
        };
      }
      for (const f of forbiddenPaths) {
        if (isInside(abs, resolveTarget(worktree, f))) {
          return {
            blocked: true,
            reason: `recursive rm targeting a forbidden path is blocked: ${t} (matches forbiddenPaths entry "${f}")`,
          };
        }
      }
    }
  }
  return { blocked: false };
}

/** Block dangerous Bash ops: git push, .git-outside-worktree touches, escaping rm. */
function checkBash(
  command: string,
  worktree: string,
  forbiddenPaths: readonly string[],
): ScopeGuardResult {
  const cmd = command ?? '';
  if (GIT_PUSH.test(cmd)) {
    return {
      blocked: true,
      reason:
        'git push is forbidden for clones — the main agent pulls; clones never push. Commit on your branch instead.',
    };
  }
  // Any token referencing a `.git` directory outside the worktree (parent
  // repo). Covers `git --git-dir=../../.git ...`, `cat ../../.git/config`,
  // `echo x > ../../.git/hooks/pre-commit`, etc. The worktree's OWN `.git`
  // pointer resolves inside the worktree and is allowed.
  for (const raw of tokenize(cmd)) {
    const cand = candidatePath(raw);
    if (!cand || cand.includes('$') || !looksPathLike(cand)) continue;
    if (cand.startsWith('~')) {
      if (cand.includes('.git')) {
        return {
          blocked: true,
          reason: `touching a .git directory outside the worktree is forbidden: ${raw}`,
        };
      }
      continue;
    }
    const abs = resolveTarget(worktree, cand);
    if (hasGitSegment(abs) && !isInside(abs, worktree)) {
      return {
        blocked: true,
        reason: `touching a .git directory outside the worktree is forbidden: ${raw}`,
      };
    }
  }
  return checkRecursiveRm(cmd, worktree, forbiddenPaths);
}

function extractWriteTargets(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  const fp = input.file_path;
  if (typeof fp === 'string' && fp) out.push(fp);
  const np = input.notebook_path;
  if (typeof np === 'string' && np) out.push(np);
  return out;
}

/**
 * Authoritative scope/safety decision for a single PreToolUse event. Pure and
 * fs-free (paths are normalized, not realpath'd) so it is deterministically
 * unit-testable; the generated `.cjs` canonicalizes inputs first, then applies
 * this same logic.
 */
export function checkScopeGuard(ctx: ScopeGuardContext): ScopeGuardResult {
  if (FILE_WRITE_TOOLS.has(ctx.tool)) {
    for (const t of extractWriteTargets(ctx.input)) {
      const r = checkWritePath(t, ctx.worktree, ctx.allowedPaths, ctx.forbiddenPaths);
      if (r.blocked) return r;
    }
    return { blocked: false };
  }
  if (ctx.tool === 'Bash') {
    const command = typeof ctx.input.command === 'string' ? ctx.input.command : '';
    return checkBash(command, ctx.worktree, ctx.forbiddenPaths);
  }
  // Read-only / unknown tools (Read, Grep, Glob, …) are never blocked.
  return { blocked: false };
}

export interface BuildScopeGuardHookScriptOptions {
  /** Absolute worktree root baked into the hook. */
  worktree: string;
  allowedPaths: readonly string[];
  forbiddenPaths: readonly string[];
  /** Used only for diagnostic messages; overridden at runtime by MANTA_CLONE_ID. */
  cloneId: string;
}

/**
 * Generate the self-contained `.cjs` PreToolUse hook. It reads the Claude Code
 * PreToolUse frame from stdin, canonicalizes paths (realpath, so the macOS
 * `/tmp`→`/private/tmp` symlink does not bypass the fence — see heartbeat-hook
 * bug), and emits a `permissionDecision: "deny"` decision (pitfalls.md §4) when
 * the scope guard blocks. On an unparseable frame it fails CLOSED — a denied
 * benign tool is recoverable noise; a silently-allowed out-of-scope `rm -rf`
 * or `git push` is not (git-lock bug #39 parity).
 *
 * The body mirrors `checkScopeGuard` and its helpers above. The generated
 * artifact is exercised directly in tests, so divergence is caught.
 */
export function buildScopeGuardHookScript(opts: BuildScopeGuardHookScriptOptions): string {
  return `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const WORKTREE_RAW = ${JSON.stringify(opts.worktree)};
const ALLOWED = ${JSON.stringify([...opts.allowedPaths])};
const FORBIDDEN = ${JSON.stringify([...opts.forbiddenPaths])};
const CLONE_ID = process.env.MANTA_CLONE_ID || ${JSON.stringify(opts.cloneId)};

const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const ROOT_ALLOWLIST = ${JSON.stringify(ROOT_ALLOWLIST)};
const GIT_PUSH = /\\bgit\\b(\\s+-\\S+(\\s+\\S+)?)*\\s+push\\b/;

// Canonicalize a path by realpath-ing its nearest existing ancestor and
// re-appending the non-existent remainder. Defeats the /tmp symlink bypass.
function canon(p) {
  const parts = [];
  let cur = path.resolve(p);
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return parts.length ? path.join(real, ...parts) : real;
    } catch (e) {
      const parent = path.dirname(cur);
      if (parent === cur) return path.normalize(path.resolve(p));
      parts.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

const WORKTREE = canon(WORKTREE_RAW);

function isInside(abs, root) {
  if (abs === root) return true;
  const withSep = root.endsWith(path.sep) ? root : root + path.sep;
  return abs.startsWith(withSep);
}
function resolveTarget(p) {
  return path.isAbsolute(p) ? canon(p) : canon(path.resolve(WORKTREE, p));
}
function hasGitSegment(abs) { return abs.split(path.sep).indexOf('.git') !== -1; }
function stripQuotes(t) {
  if (t.length >= 2 && ((t[0] === '"' && t.slice(-1) === '"') || (t[0] === "'" && t.slice(-1) === "'"))) {
    return t.slice(1, -1);
  }
  return t;
}
function tokenize(cmd) {
  const m = cmd.match(/"[^"]*"|'[^']*'|\\S+/g) || [];
  return m.map(stripQuotes);
}
function candidatePath(token) {
  let t = token;
  if (t.charAt(0) === '-') {
    const eq = t.indexOf('=');
    if (eq === -1) return '';
    t = t.slice(eq + 1);
  }
  return stripQuotes(t);
}
function looksPathLike(t) {
  return t.indexOf('/') !== -1 || t === '.git' || t.indexOf('.git') === 0 || t.charAt(0) === '~';
}

function checkWritePath(target) {
  const abs = resolveTarget(target);
  if (!isInside(abs, WORKTREE)) {
    return { blocked: true, reason: 'write outside the clone worktree is forbidden: ' + target };
  }
  for (let i = 0; i < FORBIDDEN.length; i++) {
    if (isInside(abs, resolveTarget(FORBIDDEN[i]))) {
      return { blocked: true, reason: 'write to a forbidden path is blocked: ' + target + ' (matches forbiddenPaths entry "' + FORBIDDEN[i] + '")' };
    }
  }
  for (let i = 0; i < ROOT_ALLOWLIST.length; i++) {
    if (abs === path.join(WORKTREE, ROOT_ALLOWLIST[i])) return { blocked: false };
  }
  let allowsWholeTree = false;
  for (let i = 0; i < ALLOWED.length; i++) {
    if (ALLOWED[i] === '.' || ALLOWED[i] === './' || resolveTarget(ALLOWED[i]) === WORKTREE) { allowsWholeTree = true; break; }
  }
  if (allowsWholeTree) return { blocked: false };
  for (let i = 0; i < ALLOWED.length; i++) {
    if (isInside(abs, resolveTarget(ALLOWED[i]))) return { blocked: false };
  }
  return { blocked: true, reason: 'write outside allowedPaths is blocked: ' + target + '. Allowed: ' + ALLOWED.join(', ') + '.' };
}

function checkRecursiveRm(cmd) {
  const segments = cmd.split(/&&|\\|\\||;|\\n|\\|/);
  for (let s = 0; s < segments.length; s++) {
    const toks = tokenize(segments[s].trim());
    let i = 0;
    while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++;
    const head = toks[i];
    if (!head) continue;
    if (head.split('/').pop() !== 'rm') continue;
    const args = toks.slice(i + 1);
    let recursive = false;
    const targets = [];
    for (let a = 0; a < args.length; a++) {
      const arg = args[a];
      if (arg === '--recursive' || arg === '-r' || arg === '-R') { recursive = true; continue; }
      if (arg.indexOf('--') === 0) continue;
      if (arg.charAt(0) === '-' && arg.length > 1) { if (/[rR]/.test(arg)) recursive = true; continue; }
      targets.push(arg);
    }
    if (!recursive) continue;
    for (let t = 0; t < targets.length; t++) {
      const sq = stripQuotes(targets[t]);
      if (sq.indexOf('$') !== -1 || sq.charAt(0) === '~') {
        return { blocked: true, reason: 'recursive rm with an unresolved or home-relative target is blocked: ' + targets[t] };
      }
      const abs = resolveTarget(sq);
      if (!isInside(abs, WORKTREE) || abs === WORKTREE) {
        return { blocked: true, reason: 'recursive rm targeting a path outside the clone worktree is forbidden: ' + targets[t] };
      }
      if (hasGitSegment(abs)) {
        return { blocked: true, reason: 'recursive rm targeting a .git directory is forbidden: ' + targets[t] };
      }
      for (let f = 0; f < FORBIDDEN.length; f++) {
        if (isInside(abs, resolveTarget(FORBIDDEN[f]))) {
          return { blocked: true, reason: 'recursive rm targeting a forbidden path is blocked: ' + targets[t] + ' (matches forbiddenPaths entry "' + FORBIDDEN[f] + '")' };
        }
      }
    }
  }
  return { blocked: false };
}

function checkBash(command) {
  const cmd = command || '';
  if (GIT_PUSH.test(cmd)) {
    return { blocked: true, reason: 'git push is forbidden for clones — the main agent pulls; clones never push. Commit on your branch instead.' };
  }
  const toks = tokenize(cmd);
  for (let i = 0; i < toks.length; i++) {
    const cand = candidatePath(toks[i]);
    if (!cand || cand.indexOf('$') !== -1 || !looksPathLike(cand)) continue;
    if (cand.charAt(0) === '~') {
      if (cand.indexOf('.git') !== -1) {
        return { blocked: true, reason: 'touching a .git directory outside the worktree is forbidden: ' + toks[i] };
      }
      continue;
    }
    const abs = resolveTarget(cand);
    if (hasGitSegment(abs) && !isInside(abs, WORKTREE)) {
      return { blocked: true, reason: 'touching a .git directory outside the worktree is forbidden: ' + toks[i] };
    }
  }
  return checkRecursiveRm(cmd);
}

function decide(tool, input) {
  if (FILE_WRITE_TOOLS.has(tool)) {
    const targets = [];
    if (input && typeof input.file_path === 'string' && input.file_path) targets.push(input.file_path);
    if (input && typeof input.notebook_path === 'string' && input.notebook_path) targets.push(input.notebook_path);
    for (let i = 0; i < targets.length; i++) {
      const r = checkWritePath(targets[i]);
      if (r.blocked) return r;
    }
    return { blocked: false };
  }
  if (tool === 'Bash') {
    const command = input && typeof input.command === 'string' ? input.command : '';
    return checkBash(command);
  }
  return { blocked: false };
}

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: '[manta scope-guard / ' + CLONE_ID + '] ' + reason,
    },
  }));
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const tool = data.tool_name || '';
    const toolInput = data.tool_input || {};
    const result = decide(tool, toolInput);
    if (result.blocked) {
      deny(result.reason);
    }
    // Allow: emit nothing and exit 0 so other PreToolUse hooks (heartbeat,
    // git-lock) still run and the normal permission flow proceeds.
  } catch (err) {
    // Outer frame parse failure — fail CLOSED. We cannot tell what tool this
    // is, so refuse rather than wave through a possibly-destructive op.
    deny('PreToolUse input could not be parsed (' + (err && err.message ? err.message : 'unknown') + '). Blocking for safety.');
  }
  process.exit(0);
});
`;
}
