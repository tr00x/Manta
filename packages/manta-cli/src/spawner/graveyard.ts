import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execa } from 'execa';
import { listWorktrees, removeWorktree } from './worktree.js';

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
   * Worktree paths the caller knows about (typically every
   * `registry.list()` clone's `worktree` field). The sweep canonicalises
   * BOTH these and git's reported paths via `fs.realpath` before comparing,
   * so callers can pass raw registry strings without worrying about macOS
   * `/tmp` ↔ `/private/tmp` (or any symlinked-repo-root) path-form
   * divergence. Anything under `.manta/worktrees/` whose canonical path
   * is NOT in the canonicalised known-set is classified as an orphan.
   *
   * History: an earlier `isKnown(wt) => boolean` predicate variant put the
   * canonicalisation burden on callers; `recover.ts` failed to realpath
   * its registry paths, so on any symlinked root every live clone was
   * mis-classified as orphan and `git worktree remove --force` destroyed
   * live work. The current Iterable-of-strings API centralises the
   * canonicalisation seam so no caller can accidentally drop it.
   */
  knownPaths: Iterable<string>;
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
  // Canonicalise the namespace prefix so the macOS /tmp -> /private/tmp
  // symlink case is covered. listWorktrees returns git's already-canonical
  // path; canonicalising both sides via `safeRealpath` makes the prefix
  // check and the membership check use the SAME path form.
  const repoRootCanon = await safeRealpath(opts.repoRoot);
  const mantaPrefix = path.join(repoRootCanon, '.manta', 'worktrees') + path.sep;
  const knownCanon = new Set<string>();
  for (const p of opts.knownPaths) {
    knownCanon.add(await safeRealpath(p));
  }
  const orphans = all.filter((wt) => wt.path.startsWith(mantaPrefix) && !knownCanon.has(wt.path));
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

/**
 * Best-effort `fs.realpath`: returns the canonical path when the target
 * exists, falls back to the input when it doesn't (e.g. a registry entry
 * pointing at a worktree that was deleted out-of-band). The fallback is
 * the safe direction — a non-canonical path simply fails the set membership
 * check and the orphan-dir sweep will not match a non-existent path anyway.
 */
async function safeRealpath(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return p;
  }
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
