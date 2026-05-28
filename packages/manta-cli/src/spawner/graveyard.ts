import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execa } from 'execa';
import { listWorktrees, removeWorktree, type WorktreeRecord } from './worktree.js';

export interface MoveToGraveyardOptions {
  repoRoot: string;
  cloneId: string;
  castId: string;
  worktreePath: string;
  branch: string;
}

export interface GraveyardEntry {
  castId: string;
  cloneId: string;
  movedAt: number;
  originalBranch: string;
  path: string;
}

export async function moveWorktreeToGraveyard(
  opts: MoveToGraveyardOptions,
): Promise<{ graveyardPath: string }> {
  const graveyardDir = path.join(opts.repoRoot, '.manta', 'graveyard');
  const targetDir = path.join(graveyardDir, `${opts.castId}-${opts.cloneId}`);
  await fs.mkdir(graveyardDir, { recursive: true });

  await execa('git', ['worktree', 'move', opts.worktreePath, targetDir], {
    cwd: opts.repoRoot,
  });

  const info: Omit<GraveyardEntry, 'path'> = {
    castId: opts.castId,
    cloneId: opts.cloneId,
    movedAt: Date.now(),
    originalBranch: opts.branch,
  };
  await fs.writeFile(
    path.join(targetDir, 'info.json'),
    JSON.stringify(info, null, 2),
    'utf-8',
  );

  return { graveyardPath: targetDir };
}

export interface SweepOrphanWorktreesOptions {
  repoRoot: string;
  /**
   * Predicate: given a worktree under `.manta/worktrees/`, is it known to
   * the bus (i.e. backed by a current registry entry — DEAD clones count
   * as known so operator post-mortem inspection is preserved)? Caller
   * typically builds this from `registry.list()` and matches on the
   * worktree path.
   */
  isKnown: (wt: WorktreeRecord) => boolean;
}

export interface SweepOrphanWorktreesResult {
  /** Worktree paths actively removed by this sweep (orphan = under `.manta/worktrees/` and not `isKnown`). */
  removed: string[];
  /** Worktree paths the sweep tried to remove but `git worktree remove` failed on — left in place. */
  failed: Array<{ path: string; error: string }>;
}

/**
 * Reconcile physical git worktrees against the registry, removing the gap
 * bug #43 documents:
 * - `git worktree prune` first — clears stale metadata for worktrees whose
 *   directories were already deleted out-of-band (manual `rm -rf`, partial
 *   teardown, fs corruption). Safe by design: prune only removes entries
 *   whose target dirs no longer exist.
 * - Then enumerate `git worktree list --porcelain`, keep only entries under
 *   `<repoRoot>/.manta/worktrees/` (so a user's own external worktrees are
 *   untouched), and run `removeWorktree` on any whose path is NOT known to
 *   the caller's predicate (typically: not in registry).
 *
 * Intended caller: `manta recover` and (eventually) periodic orchestrator
 * housekeeping. Read-only otherwise.
 */
export async function sweepOrphanWorktrees(
  opts: SweepOrphanWorktreesOptions,
): Promise<SweepOrphanWorktreesResult> {
  try {
    await execa('git', ['worktree', 'prune'], { cwd: opts.repoRoot });
  } catch {
    // git worktree prune failing is non-fatal — proceed to orphan-dir sweep
    // (worst case is some stale metadata stays; next cycle retries).
  }
  const all = await listWorktrees({ repoRoot: opts.repoRoot });
  // Path must be canonicalised so the prefix check is correct on macOS where
  // /tmp resolves to /private/tmp. listWorktrees returns git's reported path
  // (already canonical on macOS — `git worktree list` resolves the symlink).
  const mantaPrefix = path.join(opts.repoRoot, '.manta', 'worktrees') + path.sep;
  // Also accept canonical form for the prefix in case repoRoot was passed
  // pre-canonicalisation.
  const mantaPrefixCanon = path.join(
    await fs.realpath(opts.repoRoot).catch(() => opts.repoRoot),
    '.manta', 'worktrees',
  ) + path.sep;
  const orphans = all.filter(
    (wt) => (wt.path.startsWith(mantaPrefix) || wt.path.startsWith(mantaPrefixCanon)) && !opts.isKnown(wt),
  );
  const removed: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];
  for (const wt of orphans) {
    try {
      await removeWorktree({ repoRoot: opts.repoRoot, worktreePath: wt.path, branch: wt.branch });
      removed.push(wt.path);
    } catch (err) {
      failed.push({ path: wt.path, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { removed, failed };
}

export async function listGraveyard(repoRoot: string): Promise<GraveyardEntry[]> {
  const graveyardDir = path.join(repoRoot, '.manta', 'graveyard');
  let entries: string[];
  try {
    entries = await fs.readdir(graveyardDir);
  } catch {
    return [];
  }

  const results: GraveyardEntry[] = [];
  for (const name of entries) {
    const infoPath = path.join(graveyardDir, name, 'info.json');
    try {
      const raw = await fs.readFile(infoPath, 'utf-8');
      const info = JSON.parse(raw) as Omit<GraveyardEntry, 'path'>;
      results.push({ ...info, path: path.join(graveyardDir, name) });
    } catch {
      // skip entries without valid info.json
    }
  }
  return results;
}
