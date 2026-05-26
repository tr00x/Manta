import * as fs from 'node:fs';
import * as path from 'node:path';
import { execa } from 'execa';

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

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

export async function addWorktree(opts: AddWorktreeOptions): Promise<WorktreeRecord> {
  if (!SAFE_NAME.test(opts.name)) {
    throw new Error(`unsafe worktree name: ${opts.name}`);
  }
  const wtPath = path.join(opts.repoRoot, '.manta', 'worktrees', opts.name);

  if (fs.existsSync(wtPath)) {
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
