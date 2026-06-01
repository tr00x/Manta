import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Propagate the parent project's CLAUDE.md / CLAUDE.local.md into a clone's
 * worktree so the clone boots WITH the invoking project's instructions.
 *
 * Why this exists: a clone's worktree is a git checkout whose git-toplevel is
 * the worktree itself, so Claude Code running there cannot discover the parent
 * repo's CLAUDE.md by upward search. And CLAUDE.md is commonly gitignored (it is
 * in this repo), so `git worktree add` never places it in the checkout either.
 * Result without this: clones boot with NO project instructions — half of
 * warm-start (the other half is transcript inheritance) silently missing,
 * leaving a clone barely distinguishable from a cold subagent.
 *
 * Design (LOCKED): copy each candidate from the INVOKING user's working tree
 * (`parentRoot` — where `manta cast` ran; never a CLAUDE.md baked into Manta)
 * into the worktree, but ONLY when it is absent from the worktree. If the file
 * is tracked, `git worktree add` already placed the branch's version and we
 * must not clobber it. The copy lives only under `.manta/worktrees/` (never
 * pushed) and, being gitignored, won't be committed by the clone. `.claude/` is
 * deliberately NOT copied — it can hold secrets / settings.local.
 */
const CANDIDATES = ['CLAUDE.md', 'CLAUDE.local.md'] as const;

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function propagateProjectInstructions(args: {
  parentRoot: string;
  worktreePath: string;
}): Promise<string[]> {
  const copied: string[] = [];
  for (const name of CANDIDATES) {
    const src = path.join(args.parentRoot, name);
    const dest = path.join(args.worktreePath, name);
    try {
      // Skip when missing in the parent, or already present in the worktree
      // (tracked → git placed the branch's version; do not overwrite).
      if (!(await exists(src))) continue;
      if (await exists(dest)) continue;
      // readFile+writeFile (follows a symlinked source, yields byte-identical
      // content) rather than copyFile, so a symlinked CLAUDE.md lands as a real
      // file in the worktree.
      const content = await fs.readFile(src);
      await fs.writeFile(dest, content);
      copied.push(name);
    } catch {
      // One unreadable/unwritable candidate must never block the other or abort
      // the cast. The caller logs; a missing CLAUDE.md is never fatal.
      continue;
    }
  }
  return copied;
}
