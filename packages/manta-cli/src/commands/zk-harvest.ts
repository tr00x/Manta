import { execa } from 'execa';

export interface ZkHarvestOptions {
  castId: string;
  cloneIds: string[];
  worktrees: Array<{ cloneId: string; path: string }>;
  baseBranch: string;
  zkWrite: (note: { title: string; content: string; tags: string[] }) => Promise<void>;
}

export async function harvestCrossCandidateInsights(
  opts: ZkHarvestOptions,
): Promise<string[]> {
  const filesByClone = new Map<string, Set<string>>();

  for (const wt of opts.worktrees) {
    try {
      const r = await execa('git', ['diff', '--name-only', opts.baseBranch], {
        cwd: wt.path,
        timeout: 10_000,
      });
      const files = r.stdout
        .split('\n')
        .map((f) => f.trim())
        .filter((f) => f.length > 0);
      filesByClone.set(wt.cloneId, new Set(files));
    } catch {
      filesByClone.set(wt.cloneId, new Set());
    }
  }

  const fileToClones = new Map<string, string[]>();
  for (const [cloneId, files] of filesByClone) {
    for (const file of files) {
      const existing = fileToClones.get(file) ?? [];
      existing.push(cloneId);
      fileToClones.set(file, existing);
    }
  }

  const convergent = [...fileToClones.entries()]
    .filter(([, clones]) => clones.length >= 2)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 3);

  if (convergent.length === 0) return [];

  const written: string[] = [];
  for (const [file, clones] of convergent) {
    const title = `convergent-rewrite-${opts.castId}-${file.replace(/\//g, '-')}`;
    const content =
      `Clones ${clones.join(' and ')} both rewrote \`${file}\` in cast ${opts.castId}. ` +
      `Convergent rewrites at N=${clones.length}/${opts.cloneIds.length} suggest ` +
      `this file is a natural focal point for the task — likely a spec gap or unclear boundary.`;
    await opts.zkWrite({
      title,
      content,
      tags: [`cast-${opts.castId}`, 'loser-insights', file],
    });
    written.push(title);
  }

  return written;
}
