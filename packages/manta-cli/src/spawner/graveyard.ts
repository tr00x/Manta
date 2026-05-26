import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execa } from 'execa';

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
