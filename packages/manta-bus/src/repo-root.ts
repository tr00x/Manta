import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ResolveRepoRootOptions {
  /** Environment to read `MANTA_REPO_ROOT` from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Directory to start the `.git` walk from. Defaults to `process.cwd()`. */
  cwd?: string;
}

/**
 * Resolve the repo root that `.manta/state` lives under, the SAME way the CLI
 * does. Precedence:
 *
 *  1. `MANTA_REPO_ROOT` (resolved absolute) when set — the spawner always
 *     exports this so a cast pins to the exact repo the CLI chose.
 *  2. Otherwise walk up from `cwd` to the first ancestor that contains a
 *     `.git` entry, mirroring the CLI's repo anchoring
 *     (`manta-cli` doctor `defaultIsGitRepo` / statusline). A `.git` *file*
 *     (git worktrees use a gitfile, not a directory) counts — `existsSync`
 *     matches both, exactly like the CLI's `fs.access` probe.
 *  3. Fall back to `cwd` when no `.git` is found, preserving the historical
 *     `process.cwd()` behaviour for a non-repo directory.
 *
 * Multi-project bug (C2c): the bus previously fell back to `process.cwd()`
 * whenever `MANTA_REPO_ROOT` was unset. The CLI walks up to `.git`, so a bus
 * launched from a subdirectory anchored `.manta/state` at the subdirectory
 * while the CLI anchored it at the repo root — a split-brain where the bus and
 * CLI read/write two different state trees. Walking up to `.git` here makes the
 * two agree from any working directory inside the repo.
 */
export function resolveRepoRoot(opts: ResolveRepoRootOptions = {}): string {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const explicit = env.MANTA_REPO_ROOT;
  if (explicit !== undefined && explicit.trim() !== '') {
    return path.resolve(explicit);
  }
  return findGitRoot(cwd) ?? path.resolve(cwd);
}

/**
 * Walk up from `startDir` to the first ancestor holding a `.git` entry.
 * Returns `null` at the filesystem root if none is found.
 * `path.dirname('/') === '/'` terminates the walk.
 *
 * Bug #M15: a Manta clone's cwd is a git WORKTREE
 * (`.manta/worktrees/clone-<cast>-<id>`), whose `.git` is a FILE
 * (`gitdir: /abs/main/.git/worktrees/<name>`), not a directory. Stopping at that
 * `.git` file anchored `.manta/state` at the worktree — an EMPTY registry — while
 * the spawner pre-registered the clone in the MAIN repo's registry, so every
 * clone-side `manta.heartbeat` came back `not_found` and the clone hung in
 * STARTING. When `.git` is a worktree gitfile, resolve to the MAIN working tree
 * (the `.git/worktrees/<name>/..` → repo root) so the bus reads the same
 * `.manta/state` the spawner wrote to. (A real `.git` directory = normal repo
 * root, returned as-is.)
 */
function findGitRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    const gitPath = path.join(dir, '.git');
    if (fs.existsSync(gitPath)) {
      const mainRoot = mainWorktreeRoot(gitPath);
      return mainRoot ?? dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * If `gitPath` is a worktree gitfile (`gitdir: <abs>/.git/worktrees/<name>`),
 * return the MAIN working tree root (the directory that contains the real
 * `.git` directory the gitfile points into). Returns null for a normal `.git`
 * directory or any shape we don't recognise (caller falls back to the dir
 * holding `.git`, i.e. today's behaviour).
 */
function mainWorktreeRoot(gitPath: string): string | null {
  try {
    if (!fs.statSync(gitPath).isFile()) return null; // real .git dir → normal repo
    const content = fs.readFileSync(gitPath, 'utf8').trim();
    const m = /^gitdir:\s*(.+)$/m.exec(content);
    if (!m) return null;
    // gitdir points at <mainGitDir>/worktrees/<name>; the main repo root is the
    // parent of <mainGitDir> (the dir containing the real `.git`).
    const worktreeGitDir = path.resolve(path.dirname(gitPath), m[1]!.trim());
    const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
    const idx = worktreeGitDir.indexOf(marker);
    if (idx === -1) return null; // not a standard worktree layout
    const mainGitDir = worktreeGitDir.slice(0, idx + `${path.sep}.git`.length); // <root>/.git
    const root = path.dirname(mainGitDir);
    return fs.existsSync(path.join(root, '.git')) ? root : null;
  } catch {
    return null;
  }
}
