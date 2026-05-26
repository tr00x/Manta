import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';
import { moveWorktreeToGraveyard, listGraveyard } from '../../src/spawner/graveyard.js';
import { addWorktree } from '../../src/spawner/worktree.js';

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
});
