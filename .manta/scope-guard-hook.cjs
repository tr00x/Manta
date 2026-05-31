#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const WORKTREE_RAW = "/Users/timur/projectos/manta/.manta/worktrees/clone-cast-1780254522994-A";
const ALLOWED = ["packages/manta-bus/src","packages/manta-bus/tests","packages/manta-cli/src","packages/manta-cli/tests","packages/manta-snapshot/src","packages/manta-snapshot/tests","packages/manta-e2e/tests","docs/user","skills/manta-cast-decide","last-gasp-report.md"];
const FORBIDDEN = [".manta/state","secrets/"];
const CLONE_ID = process.env.MANTA_CLONE_ID || "A";

const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const ROOT_ALLOWLIST = ["last-gasp-report.md"];
const GIT_PUSH = /\bgit\b(\s+-\S+(\s+\S+)?)*\s+push\b/;

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
  const m = cmd.match(/"[^"]*"|'[^']*'|\S+/g) || [];
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
  const segments = cmd.split(/&&|\|\||;|\n|\|/);
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
