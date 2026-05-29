import * as path from 'node:path';
import type { Snapshot, SanitizedSnapshot } from '@manta/snapshot';
import type { SanitizationWarning } from './types.js';

/**
 * Relativise an absolute path to `root`. Returns the POSIX-relative path if
 * `p` is inside `root`, or `null` if it escapes the repo (caller drops it).
 */
function relativiseToRepo(p: string, root: string): string | null {
  const rel = path.relative(root, p);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/**
 * Sanitize a clone snapshot for bundling (Phase 7b Task 1.3).
 *
 * Default-deny: drops `parentSessionId`, `parentPid`, `recentMessages` (raw
 * transcript — research §1.4 "highest risk"), `budget`, and `sessionId`
 * entirely; collapses `parentWorktree`/`cloneWorktree` to opaque markers;
 * relativises `openFiles[].path` to the repo root (dropping any that escape).
 * `taskContract` is passed through verbatim — the command swaps in the
 * separately-sanitized contract (Task 1.4).
 *
 * The repo-root anchor for relativisation is `s.parentWorktree` (the main
 * worktree), so the function needs no external options — matching the plan's
 * `sanitizeSnapshot(s: Snapshot)` signature.
 */
export function sanitizeSnapshot(s: Snapshot): {
  sanitized: SanitizedSnapshot;
  warnings: SanitizationWarning[];
} {
  const warnings: SanitizationWarning[] = [];

  if (s.recentMessages.length > 0) {
    warnings.push({
      rule: 'snapshot.recentMessages',
      source: 'snapshot.recentMessages',
      message: `dropped ${s.recentMessages.length} transcript message(s)`,
      severity: 'warning',
    });
  }

  const repoRoot = s.parentWorktree;
  const openFiles: SanitizedSnapshot['openFiles'] = [];
  for (const f of s.openFiles) {
    const rel = relativiseToRepo(f.path, repoRoot);
    if (rel === null) {
      warnings.push({
        rule: 'snapshot.openFiles',
        source: 'snapshot.openFiles[].path',
        message: 'dropped an open-file entry whose path is outside the repo root',
        severity: 'warning',
        maskedMatch: `${f.path.slice(0, 4)}…`,
      });
      continue;
    }
    openFiles.push({ path: rel, reason: f.reason });
  }

  const sanitized: SanitizedSnapshot = {
    version: s.version,
    castId: s.castId,
    createdAt: s.createdAt,
    taskContract: s.taskContract,
    activeTodos: s.activeTodos,
    openFiles,
    parentWorktree: '<worktree>',
    cloneWorktree: `<worktree>/clone-${s.taskContract.cloneId}`,
    mode: s.mode,
    ttlSeconds: s.ttlSeconds,
    siblingCloneIds: s.siblingCloneIds,
    sessionMode: s.sessionMode,
  };

  return { sanitized, warnings };
}
