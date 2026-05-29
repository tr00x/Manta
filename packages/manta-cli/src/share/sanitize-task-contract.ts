import * as path from 'node:path';
import type { TaskContract } from '@manta/snapshot';
import type { SanitizationWarning } from './types.js';
import { scanForSecrets } from './secret-scanner.js';
import { ShareSanitizationError } from './errors.js';

/**
 * Relativise a scope path against the repo root.
 *  - Already-relative paths (e.g. `.`, `src`) are kept verbatim (a scope is
 *    normally repo-relative by construction).
 *  - Absolute in-repo paths collapse to their POSIX-relative form.
 *  - Absolute paths that escape the repo are dropped (caller warns).
 */
function relPathOrDrop(p: string, root: string): { rel: string } | { drop: true } {
  if (!path.isAbsolute(p)) return { rel: p };
  const rel = path.relative(root, p);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return { drop: true };
  return { rel: rel.split(path.sep).join('/') };
}

function sanitizePathList(
  paths: string[],
  root: string,
  rule: string,
): { kept: string[]; warnings: SanitizationWarning[] } {
  const kept: string[] = [];
  const warnings: SanitizationWarning[] = [];
  for (const p of paths) {
    const r = relPathOrDrop(p, root);
    if ('drop' in r) {
      warnings.push({
        rule,
        source: rule,
        message: 'dropped a scope path that resolves outside the repo root',
        severity: 'warning',
        maskedMatch: `${p.slice(0, 4)}…`,
      });
      continue;
    }
    kept.push(r.rel);
  }
  return { kept, warnings };
}

/**
 * Sanitize an on-disk task contract for bundling (Phase 7b Task 1.4).
 *
 * HARD BLOCK: a secret-format match in `task` or `approachHint` throws
 * `ShareSanitizationError('secret_in_task_contract')` — fail-closed, no
 * warning path. Scope paths are relativised to the repo root (out-of-repo
 * entries dropped + warned). All other fields are non-sensitive and kept.
 */
export function sanitizeTaskContract(
  c: TaskContract,
  opts: { repoRoot: string },
): { sanitized: TaskContract; warnings: SanitizationWarning[] } {
  const secretFindings = [
    ...scanForSecrets(c.task),
    ...(c.approachHint ? scanForSecrets(c.approachHint) : []),
  ];
  if (secretFindings.length > 0) {
    throw new ShareSanitizationError('secret_in_task_contract', { findings: secretFindings });
  }

  const allowed = sanitizePathList(c.scope.allowedPaths, opts.repoRoot, 'taskContract.scope.allowedPaths');
  const forbidden = sanitizePathList(c.scope.forbiddenPaths, opts.repoRoot, 'taskContract.scope.forbiddenPaths');

  const sanitized: TaskContract = {
    cloneId: c.cloneId,
    mode: c.mode,
    task: c.task,
    scope: {
      allowedPaths: allowed.kept,
      forbiddenPaths: forbidden.kept,
      maxFilesChanged: c.scope.maxFilesChanged,
    },
    approachHint: c.approachHint,
    siblingClones: c.siblingClones,
    deadlineSeconds: c.deadlineSeconds,
    sessionMode: c.sessionMode,
  };

  return { sanitized, warnings: [...allowed.warnings, ...forbidden.warnings] };
}
