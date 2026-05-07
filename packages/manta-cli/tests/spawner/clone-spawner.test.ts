import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnClone, runFakeCloneScript } from '../../src/spawner/clone-spawner.js';
import { buildCloneSnapshot } from '../../src/spawner/snapshot-builder.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'fake-clone.mjs',
);

const baseScope = { allowedPaths: ['src/'], forbiddenPaths: [], maxFilesChanged: 0 };

describe('clone-spawner', () => {
  let fx: RepoFixture | undefined;
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  it('spawnClone runs the runner with snapshot path injected via env', async () => {
    fx = await makeRepoFixture();
    const snap = buildCloneSnapshot({
      cloneId: 'A',
      mode: 'recon-swarm',
      task: 't',
      scope: baseScope,
      siblingClones: [],
      deadlineMs: 60_000,
      parentWorktree: fx.root,
      cloneWorktree: fx.root,
      parentPid: process.pid,
      parentSessionId: 'sess-test',
      castId: 'cast-1',
      budgetUsd: 5,
    });
    const handle = await spawnClone({
      repoRoot: fx.root,
      snapshot: snap,
      worktree: fx.root,
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
    });
    expect(handle.cloneId).toBe('A');
    expect(handle.snapshotPath).toContain(fx.root);
    expect(typeof handle.pid).toBe('number');
    const result = await handle.exit;
    expect(result.code).toBe(0);
  });

  it('spawnClone propagates non-zero exit', async () => {
    fx = await makeRepoFixture();
    const snap = buildCloneSnapshot({
      cloneId: 'B',
      mode: 'recon-swarm',
      task: 't',
      scope: baseScope,
      siblingClones: [],
      deadlineMs: 60_000,
      parentWorktree: fx.root,
      cloneWorktree: fx.root,
      parentPid: process.pid,
      parentSessionId: 'sess-test',
      castId: 'cast-1',
      budgetUsd: 5,
    });
    const handle = await spawnClone({
      repoRoot: fx.root,
      snapshot: snap,
      worktree: fx.root,
      runner: runFakeCloneScript({
        scriptPath: fixturePath,
        env: { MANTA_FAKE_CLONE_STATE: 'fail' },
      }),
    });
    const result = await handle.exit;
    expect(result.code).toBe(2);
  });

  it('spawnClone supports kill via signal', async () => {
    fx = await makeRepoFixture();
    const snap = buildCloneSnapshot({
      cloneId: 'C',
      mode: 'recon-swarm',
      task: 't',
      scope: baseScope,
      siblingClones: [],
      deadlineMs: 60_000,
      parentWorktree: fx.root,
      cloneWorktree: fx.root,
      parentPid: process.pid,
      parentSessionId: 'sess-test',
      castId: 'cast-1',
      budgetUsd: 5,
    });
    const handle = await spawnClone({
      repoRoot: fx.root,
      snapshot: snap,
      worktree: fx.root,
      runner: runFakeCloneScript({
        scriptPath: fixturePath,
        env: { MANTA_FAKE_CLONE_STATE: 'hang' },
      }),
    });
    handle.kill('SIGTERM');
    const result = await handle.exit;
    expect(result.signal).toBe('SIGTERM');
  });

  it('spawnClone writes the snapshot to a deterministic path under .manta/snapshots/', async () => {
    fx = await makeRepoFixture();
    const snap = buildCloneSnapshot({
      cloneId: 'D',
      mode: 'recon-swarm',
      task: 't',
      scope: baseScope,
      siblingClones: [],
      deadlineMs: 60_000,
      parentWorktree: fx.root,
      cloneWorktree: fx.root,
      parentPid: process.pid,
      parentSessionId: 'sess-test',
      castId: 'cast-1',
      budgetUsd: 5,
    });
    const handle = await spawnClone({
      repoRoot: fx.root,
      snapshot: snap,
      worktree: fx.root,
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
    });
    expect(handle.snapshotPath).toMatch(/\.manta\/snapshots\/cast-1\/D\.snapshot\.json$/);
    await handle.exit;
  });
});
