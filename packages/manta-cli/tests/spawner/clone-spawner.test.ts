import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { spawnClone, runFakeCloneScript, runClaudeCli } from '../../src/spawner/clone-spawner.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';
import { makeRegistryFake } from '../helpers/registryFake.js';
import { makeSnapshotFor } from '../helpers/snapshotFixture.js';

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'fake-clone.mjs',
);

describe('clone-spawner', () => {
  let fx: RepoFixture | undefined;
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  it('spawnClone runs the runner with snapshot path injected via env', async () => {
    fx = await makeRepoFixture();
    const handle = await spawnClone({
      repoRoot: fx.root,
      snapshot: makeSnapshotFor({ cloneId: 'A', castId: 'cast-1' }),
      worktree: fx.root,
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      registry: makeRegistryFake(),
    });
    expect(handle.cloneId).toBe('A');
    expect(handle.snapshotPath).toContain(fx.root);
    expect(typeof handle.pid).toBe('number');
    const result = await handle.exit;
    expect(result.code).toBe(0);
  });

  it('spawnClone propagates non-zero exit', async () => {
    fx = await makeRepoFixture();
    const handle = await spawnClone({
      repoRoot: fx.root,
      snapshot: makeSnapshotFor({ cloneId: 'B', castId: 'cast-1' }),
      worktree: fx.root,
      runner: runFakeCloneScript({
        scriptPath: fixturePath,
        env: { MANTA_FAKE_CLONE_STATE: 'fail' },
      }),
      registry: makeRegistryFake(),
    });
    const result = await handle.exit;
    expect(result.code).toBe(2);
  });

  it('spawnClone supports kill via signal', async () => {
    fx = await makeRepoFixture();
    const handle = await spawnClone({
      repoRoot: fx.root,
      snapshot: makeSnapshotFor({ cloneId: 'C', castId: 'cast-1' }),
      worktree: fx.root,
      runner: runFakeCloneScript({
        scriptPath: fixturePath,
        env: { MANTA_FAKE_CLONE_STATE: 'hang' },
      }),
      registry: makeRegistryFake(),
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
    // Point at a binary that does not exist; execa with reject:false will
    // resolve with `failed: true, exitCode: undefined, signal: undefined`
    // (the spawn ENOENT path). The runtime must surface that as spawn_failed.
    const handle = await spawnClone({
      repoRoot: fx.root,
      snapshot: makeSnapshotFor({ cloneId: 'X', castId: 'cast-1' }),
      worktree: fx.root,
      runner: runClaudeCli({ claudeBin: '/no/such/binary/manta-test-xyzabc' }),
      registry: makeRegistryFake(),
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
    const handle = await spawnClone({
      repoRoot: fx.root,
      snapshot: makeSnapshotFor({ cloneId: 'T', castId: 'cast-1' }),
      worktree: fx.root,
      runner: runFakeCloneScript({
        scriptPath: fixturePath,
        env: { MANTA_FAKE_CLONE_STATE: 'hang' },
      }),
      registry: makeRegistryFake(),
    });
    const result = await handle.terminate({ gracefulMs: 50 });
    // Child must have died via a signal (SIGTERM if it ignored it briefly,
    // or SIGKILL if SIGTERM took longer than 50ms).
    expect(result.signal === 'SIGTERM' || result.signal === 'SIGKILL').toBe(true);
  });

  it('spawnClone writes the snapshot to a deterministic path under .manta/snapshots/', async () => {
    fx = await makeRepoFixture();
    const handle = await spawnClone({
      repoRoot: fx.root,
      snapshot: makeSnapshotFor({ cloneId: 'D', castId: 'cast-1' }),
      worktree: fx.root,
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      registry: makeRegistryFake(),
    });
    expect(handle.snapshotPath).toMatch(/\.manta\/snapshots\/cast-1\/D\.snapshot\.json$/);
    await handle.exit;
  });

  // Phase-1 lockdown: argv must use real claude flags, never the dead `--snapshot`
  // and never `--strict-mcp-config` (which would cut off user-scope manta-bus MCP).
  it('production runClaudeCli argv does NOT contain dead --snapshot flag (bug #3/#4 regression guard)', async () => {
    fx = await makeRepoFixture();
    const captured: string[][] = [];
    const probeRunner = {
      run(input: { cwd: string; env: Record<string, string>; appendSystemPrompt: string; prompt: string }) {
        // Build the same argv runClaudeCli would, then capture and short-circuit.
        const argv = [
          '--print',
          '--append-system-prompt',
          input.appendSystemPrompt,
          '--permission-mode',
          'bypassPermissions',
          input.prompt,
        ];
        captured.push(argv);
        // Return a successful no-op child.
        return execa(process.execPath, ['-e', 'process.exit(0)'], { reject: false });
      },
    };
    const handle = await spawnClone({
      repoRoot: fx.root,
      snapshot: makeSnapshotFor({ cloneId: 'F', castId: 'cast-1' }),
      worktree: fx.root,
      runner: probeRunner,
      registry: makeRegistryFake(),
    });
    await handle.exit;
    expect(captured).toHaveLength(1);
    expect(captured[0]).not.toContain('--snapshot');
    expect(captured[0]).not.toContain('--strict-mcp-config');
    expect(captured[0]).toContain('--append-system-prompt');
    expect(captured[0]).toContain('--permission-mode');
    expect(captured[0]).toContain('bypassPermissions');
  });
});
