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

  it('addWorktree cleans up stale worktree at same path', async () => {
    fx = await makeRepoFixture();
    const wt1 = await addWorktree({ repoRoot: fx.root, name: 'clone-A', branch: 'manta/cast-1/A' });
    expect(wt1.path).toContain('clone-A');
    const wt2 = await addWorktree({ repoRoot: fx.root, name: 'clone-A', branch: 'manta/cast-2/A' });
    expect(wt2.branch).toBe('manta/cast-2/A');
    const all = await listWorktrees({ repoRoot: fx.root });
    const cloneAEntries = all.filter((w: WorktreeRecord) => w.branch.includes('/A'));
    expect(cloneAEntries).toHaveLength(1);
    expect(cloneAEntries[0]!.branch).toBe('manta/cast-2/A');
  });

  it('addWorktree refuses to clobber an orphan worktree with uncommitted changes (bug #64)', async () => {
    fx = await makeRepoFixture();
    const wt1 = await addWorktree({ repoRoot: fx.root, name: 'clone-A', branch: 'manta/cast-1/A' });
    // Simulate a CRASHED clone that left uncommitted work behind in its worktree
    // (a graceful-death clone would have committed everything → clean tree).
    await fs.writeFile(path.join(wt1.path, 'uncommitted-work.txt'), 'precious unsaved output');
    // A later cast that reuses clone-letter A lands on the SAME dir. It must NOT
    // `rm -rf` the unsaved work — it must refuse.
    await expect(
      addWorktree({ repoRoot: fx.root, name: 'clone-A', branch: 'manta/cast-2/A' }),
    ).rejects.toThrow(/uncommitted changes|bug #64/i);
    // The unsaved work survives the refusal.
    const survived = await fs
      .access(path.join(wt1.path, 'uncommitted-work.txt'))
      .then(() => true)
      .catch(() => false);
    expect(survived).toBe(true);
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
