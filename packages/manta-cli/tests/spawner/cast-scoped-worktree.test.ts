import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import {
  addWorktree,
  listWorktrees,
  cloneWorktreeName,
  cloneWorktreePath,
} from '../../src/spawner/worktree.js';
import { sweepOrphanWorktrees } from '../../src/spawner/graveyard.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';

/**
 * bug #64 (structural fix): worktree dirs are cast-scoped, not letter-scoped.
 * Two casts that reuse the same clone LETTER must land on DISJOINT dirs so a
 * freed-letter reuse can NEVER alias another cast's directory.
 */
describe('cast-scoped worktree paths (bug #64)', () => {
  let fx: RepoFixture | undefined;
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  it('cloneWorktreeName/Path encode BOTH castId and cloneId — same letter, two casts → disjoint', () => {
    const nameA1 = cloneWorktreeName('cast-1', 'A');
    const nameA2 = cloneWorktreeName('cast-2', 'A');
    // Same letter, different cast → different dir name (no aliasing).
    expect(nameA1).not.toBe(nameA2);
    expect(nameA1).toBe('clone-cast-1-A');
    expect(nameA2).toBe('clone-cast-2-A');

    const pathA1 = cloneWorktreePath('/repo', 'cast-1', 'A');
    const pathA2 = cloneWorktreePath('/repo', 'cast-2', 'A');
    expect(pathA1).not.toBe(pathA2);
    expect(pathA1.endsWith('/.manta/worktrees/clone-cast-1-A')).toBe(true);
    expect(pathA2.endsWith('/.manta/worktrees/clone-cast-2-A')).toBe(true);

    // The cast-scoped name must still satisfy addWorktree's SAFE_NAME guard
    // (single path segment, no separators) — castId carries its own `cast-`.
    expect(nameA1).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('two casts reusing letter A get two real, coexisting worktrees (no clobber)', async () => {
    fx = await makeRepoFixture('manta-cast-scope-');
    // Canonicalise the root (macOS /tmp -> /private/tmp): git worktree list
    // returns canonical paths, so addWorktree must run against the same form
    // for wt.path to match the listed entries.
    const root = await fs.realpath(fx.root);
    // cast-1 clone A, then cast-2 clone A: in the OLD letter-only scheme these
    // aliased the same dir (the second clobbered/triggered the reuse guard).
    // Cast-scoped names make them disjoint, so BOTH coexist with no guard hit.
    const wt1 = await addWorktree({
      repoRoot: root,
      name: cloneWorktreeName('cast-1', 'A'),
      branch: 'manta/cast-1/A',
    });
    const wt2 = await addWorktree({
      repoRoot: root,
      name: cloneWorktreeName('cast-2', 'A'),
      branch: 'manta/cast-2/A',
    });

    expect(wt1.path).not.toBe(wt2.path);
    expect(wt1.path).toContain('clone-cast-1-A');
    expect(wt2.path).toContain('clone-cast-2-A');

    // Both dirs physically exist simultaneously — proof there is no aliasing.
    const all = await listWorktrees({ repoRoot: root });
    const paths = all.map((w) => w.path);
    expect(paths).toContain(wt1.path);
    expect(paths).toContain(wt2.path);

    // And each carries its own checked-out branch (independent histories).
    const branches = all.map((w) => w.branch);
    expect(branches).toContain('manta/cast-1/A');
    expect(branches).toContain('manta/cast-2/A');
  });

  it('recover sweep (sweepOrphanWorktrees) cleans a cast-scoped orphan dir', async () => {
    fx = await makeRepoFixture('manta-cast-scope-recover-');
    const root = await fs.realpath(fx.root);
    // Two cast-scoped worktrees for the same letter; the registry only "knows"
    // cast-2's (cast-1's is an orphan — its cast process exited / registry
    // wiped between casts). recover must reconcile and sweep the orphan.
    const orphan = await addWorktree({
      repoRoot: root,
      name: cloneWorktreeName('cast-1', 'A'),
      branch: 'manta/cast-1/A',
    });
    const known = await addWorktree({
      repoRoot: root,
      name: cloneWorktreeName('cast-2', 'A'),
      branch: 'manta/cast-2/A',
    });

    const result = await sweepOrphanWorktrees({
      repoRoot: root,
      knownPaths: [known.path], // cast-1's dir is not registered → orphan
    });

    expect(result.removed).toEqual([orphan.path]);
    expect(result.failed).toEqual([]);

    const remaining = (await listWorktrees({ repoRoot: root })).map((w) => w.path);
    expect(remaining).toContain(known.path);
    expect(remaining).not.toContain(orphan.path);
  });
});
