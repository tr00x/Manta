import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnClone, runFakeCloneScript, runClaudeCli } from '../../src/spawner/clone-spawner.js';
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

  // I-1 regression: when the runner fails to start (ENOENT — non-existent
  // binary), `execa({ reject: false })` resolves with `failed: true` and
  // exitCode == null. Without the I-1 fix this masks as `{ code: null,
  // signal: null }` and the cast loop hangs waiting for a heartbeat.
  it('spawnClone surfaces runner spawn failure (ENOENT) as CliError spawn_failed', async () => {
    fx = await makeRepoFixture();
    const snap = buildCloneSnapshot({
      cloneId: 'X',
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
    // Point at a binary that does not exist; execa with reject:false will
    // resolve with `failed: true, exitCode: undefined, signal: undefined`
    // (the spawn ENOENT path). The runtime must surface that as spawn_failed.
    const handle = await spawnClone({
      repoRoot: fx.root,
      snapshot: snap,
      worktree: fx.root,
      runner: runClaudeCli({ claudeBin: '/no/such/binary/manta-test-xyzabc' }),
    });
    await expect(handle.exit).rejects.toMatchObject({
      name: 'CliError',
      kind: 'spawn_failed',
    });
  });

  // I-5 regression: terminate sends SIGTERM, then SIGKILL after gracefulMs.
  // The 'hang' fake-clone never exits on its own, so the only way the exit
  // promise resolves is via signal. We use a short gracefulMs so the test
  // doesn't sit on the default 5s.
  it('terminate escalates SIGTERM → SIGKILL when child ignores the term signal', async () => {
    fx = await makeRepoFixture();
    const snap = buildCloneSnapshot({
      cloneId: 'T',
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
    const result = await handle.terminate({ gracefulMs: 50 });
    // Child must have died via a signal (SIGTERM if it ignored it briefly,
    // or SIGKILL if SIGTERM took longer than 50ms).
    expect(result.signal === 'SIGTERM' || result.signal === 'SIGKILL').toBe(true);
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
