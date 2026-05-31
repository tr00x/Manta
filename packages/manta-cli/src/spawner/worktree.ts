import * as fs from 'node:fs';
import * as path from 'node:path';
import { execa } from 'execa';

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * bug #64 (structural fix): the canonical worktree dir NAME for a clone, scoped
 * by BOTH castId and cloneId. Two casts that reuse the same clone letter (e.g.
 * cast-1 frees `A`, cast-2 allocates `A`) now land on DISJOINT dirs
 * (`clone-cast-1-A` vs `clone-cast-2-A`), so a freed-letter reuse can never
 * alias another cast's directory. This is the single source of truth for the
 * naming scheme — every call site (cast spawn, merge-review/merge-all fallback,
 * promote, share) MUST derive its path through {@link cloneWorktreeName} /
 * {@link cloneWorktreePath} so none can drift back onto the old letter-only
 * scheme and reintroduce the alias. castId already carries a `cast-` prefix
 * (e.g. `cast-1780248713179`), so the resulting name is `clone-cast-…-A`.
 */
export function cloneWorktreeName(castId: string, cloneId: string): string {
  return `clone-${castId}-${cloneId}`;
}

/** Absolute path of a clone's cast-scoped worktree. See {@link cloneWorktreeName}. */
export function cloneWorktreePath(repoRoot: string, castId: string, cloneId: string): string {
  return path.join(repoRoot, '.manta', 'worktrees', cloneWorktreeName(castId, cloneId));
}

export interface WorktreeRecord {
  path: string;
  branch: string;
}

export interface AddWorktreeOptions {
  repoRoot: string;
  name: string;
  branch: string;
}

export interface RemoveWorktreeOptions {
  repoRoot: string;
  worktreePath: string;
  branch: string;
}

/**
 * bug #64 (data-loss guard): is the worktree at `wtPath` a git worktree with
 * uncommitted changes? Used to refuse clobbering unsaved work on clone-letter
 * reuse. A non-worktree leftover dir (or any git failure) is treated as
 * not-dirty so the historical reclaim path still applies.
 */
async function worktreeHasUncommittedChanges(wtPath: string): Promise<boolean> {
  try {
    const r = await execa('git', ['status', '--porcelain'], { cwd: wtPath });
    return r.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export async function addWorktree(opts: AddWorktreeOptions): Promise<WorktreeRecord> {
  if (!SAFE_NAME.test(opts.name)) {
    throw new Error(`unsafe worktree name: ${opts.name}`);
  }
  const wtPath = path.join(opts.repoRoot, '.manta', 'worktrees', opts.name);

  if (fs.existsSync(wtPath)) {
    // bug #64: cast-scoped names (cloneWorktreeName) now make letter reuse across
    // casts land on DISJOINT dirs, so the cross-cast aliasing that motivated this
    // guard is gone structurally. This guard REMAINS as defense-in-depth for the
    // residual cases where a dir can still pre-exist: a retried cast reusing its
    // own castId+letter, or a manual/out-of-band dir at this path. An existing
    // dir here is therefore an ORPHAN from a prior run of the SAME identity. A
    // graceful-death clone committed its work to its branch (clean tree → safe to
    // reclaim); a CRASHED clone may have left UNCOMMITTED work. Refuse to `rm -rf`
    // unsaved work — surface it for the operator instead of silently destroying it.
    if (await worktreeHasUncommittedChanges(wtPath)) {
      throw new Error(
        `refusing to reuse worktree ${wtPath}: it has uncommitted changes from a ` +
          `previous clone (orphan). Inspect/commit or remove it manually, then retry — ` +
          `letter reuse must never clobber unsaved work (bug #64).`,
      );
    }
    try {
      await execa('git', ['worktree', 'remove', '--force', wtPath], { cwd: opts.repoRoot });
    } catch {
      await fs.promises.rm(wtPath, { recursive: true, force: true });
    }
    await execa('git', ['worktree', 'prune'], { cwd: opts.repoRoot });
  }

  try {
    await execa('git', ['branch', '-D', opts.branch], { cwd: opts.repoRoot });
  } catch {
    // branch doesn't exist — expected for fresh casts
  }

  await execa('git', ['worktree', 'add', '-b', opts.branch, wtPath, 'HEAD'], {
    cwd: opts.repoRoot,
  });
  return { path: wtPath, branch: opts.branch };
}

export async function removeWorktree(opts: RemoveWorktreeOptions): Promise<void> {
  await execa('git', ['worktree', 'remove', '--force', opts.worktreePath], {
    cwd: opts.repoRoot,
  });
  // Best-effort branch cleanup; ignore if branch was already deleted.
  try {
    await execa('git', ['branch', '-D', opts.branch], { cwd: opts.repoRoot });
  } catch {
    // intentional: branch may already be gone
  }
}

export async function listWorktrees(opts: { repoRoot: string }): Promise<WorktreeRecord[]> {
  const r = await execa('git', ['worktree', 'list', '--porcelain'], { cwd: opts.repoRoot });
  // Porcelain blocks: each block has lines `worktree <path>`, `HEAD <sha>`,
  // optionally `branch refs/heads/<name>`.
  const blocks = r.stdout.split('\n\n');
  const out: WorktreeRecord[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const wtLine = lines.find((l) => l.startsWith('worktree '));
    const branchLine = lines.find((l) => l.startsWith('branch '));
    if (!wtLine) continue;
    const wtPath = wtLine.slice('worktree '.length).trim();
    const branch = branchLine
      ? branchLine.slice('branch refs/heads/'.length).trim()
      : '(detached)';
    out.push({ path: wtPath, branch });
  }
  return out;
}
