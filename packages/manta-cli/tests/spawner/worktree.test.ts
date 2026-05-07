import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  addWorktree,
  removeWorktree,
  listWorktrees,
  type WorktreeRecord,
} from '../../src/spawner/worktree.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';

describe('worktree', () => {
  let fx: RepoFixture | undefined;
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  it('addWorktree creates a working tree at the requested path on a new branch', async () => {
    fx = await makeRepoFixture();
    const wt = await addWorktree({ repoRoot: fx.root, name: 'clone-A', branch: 'manta/clone-A' });
    expect(wt.path).toContain('clone-A');
    expect(wt.branch).toBe('manta/clone-A');
    const exists = await fs
      .access(path.join(wt.path, 'README.md'))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  it('removeWorktree tears down the working tree and prunes the branch', async () => {
    fx = await makeRepoFixture();
    const wt = await addWorktree({ repoRoot: fx.root, name: 'clone-A', branch: 'manta/clone-A' });
    await removeWorktree({ repoRoot: fx.root, worktreePath: wt.path, branch: wt.branch });
    const stillThere = await fs
      .access(wt.path)
      .then(() => true)
      .catch(() => false);
    expect(stillThere).toBe(false);
  });

  it('listWorktrees returns all worktrees including the main one', async () => {
    fx = await makeRepoFixture();
    await addWorktree({ repoRoot: fx.root, name: 'clone-A', branch: 'manta/clone-A' });
    await addWorktree({ repoRoot: fx.root, name: 'clone-B', branch: 'manta/clone-B' });
    const all = await listWorktrees({ repoRoot: fx.root });
    expect(all.length).toBeGreaterThanOrEqual(3);
    const branches = all.map((w: WorktreeRecord) => w.branch);
    expect(branches).toContain('manta/clone-A');
    expect(branches).toContain('manta/clone-B');
  });

  it('addWorktree rejects an unsafe name', async () => {
    fx = await makeRepoFixture();
    await expect(
      addWorktree({ repoRoot: fx.root, name: '../escape', branch: 'x' }),
    ).rejects.toThrow();
    await expect(
      addWorktree({ repoRoot: fx.root, name: 'sub/dir', branch: 'x' }),
    ).rejects.toThrow();
  });
});
