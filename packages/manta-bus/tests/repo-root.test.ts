import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveRepoRoot } from '../src/repo-root';

let repoRoot: string;

beforeEach(async () => {
  // realpath the tmp dir so macOS /tmp -> /private/tmp symlink does not make
  // the resolver's path.resolve output differ from our expected string.
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-reporoot-'));
  repoRoot = await fs.realpath(raw);
  await fs.mkdir(path.join(repoRoot, '.git'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(repoRoot, { recursive: true, force: true });
});

/**
 * Mirror of the CLI's repo anchoring (`manta-cli` doctor `defaultIsGitRepo`):
 * walk up from `cwd` to the first ancestor containing `.git`. The C2c contract
 * is that the bus agrees with this from any working directory inside the repo.
 */
async function cliWalkToGitRoot(cwd: string): Promise<string | null> {
  let dir = path.resolve(cwd);
  for (;;) {
    try {
      await fs.access(path.join(dir, '.git'));
      return dir;
    } catch {
      // climb
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

describe('resolveRepoRoot', () => {
  it('honours MANTA_REPO_ROOT (resolved absolute) over the cwd walk', () => {
    const resolved = resolveRepoRoot({
      env: { MANTA_REPO_ROOT: repoRoot },
      cwd: '/some/unrelated/dir',
    });
    expect(resolved).toBe(repoRoot);
  });

  it('resolves a relative MANTA_REPO_ROOT against the process', () => {
    const resolved = resolveRepoRoot({ env: { MANTA_REPO_ROOT: '.' }, cwd: repoRoot });
    expect(resolved).toBe(path.resolve('.'));
  });

  it('walks up to .git when MANTA_REPO_ROOT is unset (subdir => repo root)', async () => {
    const deep = path.join(repoRoot, 'packages', 'manta-cli', 'src');
    await fs.mkdir(deep, { recursive: true });
    const resolved = resolveRepoRoot({ env: {}, cwd: deep });
    expect(resolved).toBe(repoRoot);
  });

  it('a .git FILE (worktree gitfile) also anchors the root', async () => {
    const wtRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'manta-wt-')));
    try {
      await fs.writeFile(path.join(wtRoot, '.git'), 'gitdir: /somewhere/.git/worktrees/x\n');
      const sub = path.join(wtRoot, 'a', 'b');
      await fs.mkdir(sub, { recursive: true });
      expect(resolveRepoRoot({ env: {}, cwd: sub })).toBe(wtRoot);
    } finally {
      await fs.rm(wtRoot, { recursive: true, force: true });
    }
  });

  it('bus invoked from a subdir resolves the SAME root as the CLI walk', async () => {
    const deep = path.join(repoRoot, 'packages', 'manta-bus', 'tests', 'nested');
    await fs.mkdir(deep, { recursive: true });
    const busResolved = resolveRepoRoot({ env: {}, cwd: deep });
    const cliResolved = await cliWalkToGitRoot(deep);
    expect(busResolved).toBe(cliResolved);
    expect(busResolved).toBe(repoRoot);
  });

  it('falls back to cwd when no .git is found in any ancestor', async () => {
    // A tmp dir with NO .git anywhere up to it. Use a sibling of repoRoot that
    // we know has no .git of its own; the walk may still hit a .git far up the
    // real filesystem, so assert parity with the CLI walk instead of a literal.
    const noGit = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'manta-nogit-')));
    try {
      const busResolved = resolveRepoRoot({ env: {}, cwd: noGit });
      const cliResolved = await cliWalkToGitRoot(noGit);
      // Either both find the same far-up .git, or neither does and bus falls
      // back to cwd. In both cases the bus must not diverge from the CLI.
      expect(busResolved).toBe(cliResolved ?? noGit);
    } finally {
      await fs.rm(noGit, { recursive: true, force: true });
    }
  });
});
