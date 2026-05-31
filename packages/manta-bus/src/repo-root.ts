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
 */
function findGitRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
