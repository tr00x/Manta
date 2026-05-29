import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';
import { moveWorktreeToGraveyard, listGraveyard, sweepOrphanWorktrees } from '../../src/spawner/graveyard.js';
import { addWorktree, listWorktrees } from '../../src/spawner/worktree.js';

describe('graveyard', () => {
  let fx: RepoFixture | undefined;
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  it('moves a worktree to graveyard with info.json sidecar', async () => {
    fx = await makeRepoFixture('manta-grave-');
    const wt = await addWorktree({
      repoRoot: fx.root,
      name: 'clone-A',
      branch: 'manta/cast-1/A',
    });

    const { graveyardPath } = await moveWorktreeToGraveyard({
      repoRoot: fx.root,
      cloneId: 'A',
      castId: 'cast-1',
      worktreePath: wt.path,
      branch: wt.branch,
    });

    expect(graveyardPath).toContain('graveyard');
    expect(graveyardPath).toContain('cast-1-A');

    const info = JSON.parse(await fs.readFile(path.join(graveyardPath, 'info.json'), 'utf-8'));
    expect(info.castId).toBe('cast-1');
    expect(info.cloneId).toBe('A');
    expect(info.originalBranch).toBe('manta/cast-1/A');
    expect(typeof info.movedAt).toBe('number');
  });

  it('listGraveyard returns moved entries', async () => {
    fx = await makeRepoFixture('manta-grave-list-');
    const wt = await addWorktree({
      repoRoot: fx.root,
      name: 'clone-B',
      branch: 'manta/cast-2/B',
    });

    await moveWorktreeToGraveyard({
      repoRoot: fx.root,
      cloneId: 'B',
      castId: 'cast-2',
      worktreePath: wt.path,
      branch: wt.branch,
    });

    const entries = await listGraveyard(fx.root);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.castId).toBe('cast-2');
    expect(entries[0]!.cloneId).toBe('B');
  });

  it('listGraveyard returns empty array when no graveyard dir', async () => {
    fx = await makeRepoFixture('manta-grave-empty-');
    const entries = await listGraveyard(fx.root);
    expect(entries).toHaveLength(0);
  });

  describe('sweepOrphanWorktrees (bug #43)', () => {
    // macOS /tmp -> /private/tmp symlink: mkdtemp returns /tmp/... but git
    // worktree list canonicalises to /private/tmp/... — comparisons need to
    // happen in canonical form for the test to be portable across hosts.
    const canon = async (p: string): Promise<string> => fs.realpath(p);

    it('removes worktrees under .manta/worktrees/ that are not in knownPaths', async () => {
      fx = await makeRepoFixture('manta-orphan-sweep-');
      const root = await canon(fx.root);
      // Create three worktrees: A (orphan), B (known/live), C (known/DEAD-style).
      const wtA = await addWorktree({ repoRoot: root, name: 'clone-A', branch: 'manta/cast-x/A' });
      const wtB = await addWorktree({ repoRoot: root, name: 'clone-B', branch: 'manta/cast-x/B' });
      const wtC = await addWorktree({ repoRoot: root, name: 'clone-C', branch: 'manta/cast-x/C' });

      const result = await sweepOrphanWorktrees({
        repoRoot: root,
        knownPaths: [wtB.path, wtC.path], // A is the orphan
      });

      expect(result.removed).toEqual([wtA.path]);
      expect(result.failed).toEqual([]);

      const remaining = await listWorktrees({ repoRoot: root });
      const remainingPaths = remaining.map((w) => w.path);
      expect(remainingPaths).toContain(wtB.path);
      expect(remainingPaths).toContain(wtC.path);
      expect(remainingPaths).not.toContain(wtA.path);
    });

    it('preserves worktrees outside .manta/worktrees/ (user-owned, never swept)', async () => {
      fx = await makeRepoFixture('manta-orphan-external-');
      const root = await canon(fx.root);
      // Create an "external" worktree the user owns (outside .manta/worktrees/).
      const externalPath = path.join(root, 'my-feature-branch');
      const { execa } = await import('execa');
      await execa('git', ['worktree', 'add', '-b', 'feature/x', externalPath, 'HEAD'], { cwd: root });

      const result = await sweepOrphanWorktrees({
        repoRoot: root,
        knownPaths: [], // pretend nothing is known
      });
      expect(result.removed).toEqual([]); // external worktree is out of namespace, never swept

      const remaining = await listWorktrees({ repoRoot: root });
      expect(remaining.some((w) => w.path === externalPath)).toBe(true);
    });

    it('prunes stale git worktree metadata for already-deleted directories', async () => {
      fx = await makeRepoFixture('manta-orphan-prune-');
      const root = await canon(fx.root);
      const wt = await addWorktree({ repoRoot: root, name: 'clone-X', branch: 'manta/cast-y/X' });
      // Out-of-band: nuke the directory but leave git's metadata pointing at it.
      await fs.rm(wt.path, { recursive: true, force: true });
      // git's `worktree list` still reports the entry until prune runs.
      const beforePrune = await listWorktrees({ repoRoot: root });
      expect(beforePrune.some((w) => w.path === wt.path)).toBe(true);

      await sweepOrphanWorktrees({
        repoRoot: root,
        knownPaths: [],
      });

      const afterPrune = await listWorktrees({ repoRoot: root });
      expect(afterPrune.some((w) => w.path === wt.path)).toBe(false);
    });

    it('returns empty result on a clean repo (no .manta/worktrees/)', async () => {
      fx = await makeRepoFixture('manta-orphan-clean-');
      const root = await canon(fx.root);
      const result = await sweepOrphanWorktrees({
        repoRoot: root,
        knownPaths: [],
      });
      expect(result.removed).toEqual([]);
      expect(result.failed).toEqual([]);
    });

    it('preserves live worktrees when knownPaths uses non-canonical repo root (bug-hunt MAJOR-1 over cast-1780011340100)', async () => {
      // Post-9540cf3 bug-hunt cast (cast-1780011340100, clones A+B both
      // independently) flagged: on macOS where /tmp -> /private/tmp,
      // registry stores `c.worktree = /tmp/.../clone-A` (non-canonical)
      // while git reports `/private/tmp/.../clone-A` (canonical). Pre-fix
      // the predicate compared strings verbatim → live clones flagged as
      // orphans → `git worktree remove --force` destroyed live work + branch.
      // Post-fix sweepOrphanWorktrees canonicalises both sides via
      // realpath. This test pins the divergence: register the worktree
      // under the non-canonical root, pass the non-canonical path as
      // knownPaths, assert sweep does NOT remove it.
      fx = await makeRepoFixture('manta-orphan-canon-');
      const rawRoot = fx.root;            // e.g. /tmp/manta-orphan-canon-* on macOS
      const canonRoot = await canon(rawRoot); // /private/tmp/manta-orphan-canon-*

      // Skip if the host filesystem doesn't realise the symlink divergence
      // (Linux CI typically has identical raw and canonical paths). The
      // bug is only reachable when the two diverge.
      if (rawRoot === canonRoot) return;

      // Register the worktree under the NON-canonical root — mirrors how
      // cast.ts / clone-spawner build the path and persist it to the
      // registry's `worktree` field.
      const wt = await addWorktree({ repoRoot: rawRoot, name: 'clone-A', branch: 'manta/cast-canon/A' });
      expect(wt.path.startsWith(rawRoot)).toBe(true);

      // git canonicalises in its reports; divergence confirmed.
      const live = await listWorktrees({ repoRoot: canonRoot });
      const liveClone = live.find((w) => w.path.endsWith('clone-A'));
      expect(liveClone, 'live clone-A must appear in git worktree list').toBeDefined();
      expect(liveClone!.path.startsWith(canonRoot)).toBe(true);
      expect(liveClone!.path).not.toBe(wt.path); // raw vs canonical diverge

      // Sweep with the NON-canonical registry path — internal realpath
      // canonicalisation must recognise the live clone.
      const result = await sweepOrphanWorktrees({
        repoRoot: rawRoot,
        knownPaths: [wt.path], // non-canonical, as registry stores it
      });
      expect(result.removed).toEqual([]); // live clone preserved
      expect(result.failed).toEqual([]);

      // Worktree still on disk after sweep.
      const afterSweep = await listWorktrees({ repoRoot: canonRoot });
      expect(afterSweep.some((w) => w.path === liveClone!.path)).toBe(true);
    });
  });
});
