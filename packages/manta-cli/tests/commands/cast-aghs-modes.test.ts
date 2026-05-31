import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runCastCommand } from '../../src/commands/cast.js';
import { runFakeCloneScript } from '../../src/spawner/clone-spawner.js';
import { createReporter, MemorySink } from '../../src/output/reporter.js';
import { createRuntime } from '../../src/runtime.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';
import { cloneWorktreePath } from '../../src/spawner/worktree.js';
import type { Mode } from '@manta/bus';

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'fake-clone.mjs',
);

// Each test owns the MANTA_UNLOCK_AGHS env var fully — set in the test, cleared
// in afterEach so a leak never unlocks a sibling test's cast. Vitest runs tests
// within a file serially, so this swap is safe.
function withEnv(value: string | undefined) {
  if (value === undefined) delete process.env.MANTA_UNLOCK_AGHS;
  else process.env.MANTA_UNLOCK_AGHS = value;
}

const baseOpts = {
  cycleIntervalMs: 50,
  reporter: createReporter({ sink: new MemorySink() }),
  tickBudgetMs: 5_000,
  internalTokenEstimatePerClone: 4,
  internalTokenEstimatePerCast: 15,
  verifyMcp: false as const,
};

describe('Phase 8 — Aghs gate (decoy / council)', () => {
  let fx: RepoFixture | undefined;
  afterEach(async () => {
    withEnv(undefined);
    await fx?.cleanup();
    fx = undefined;
  });

  for (const mode of ['decoy', 'council'] as const) {
    it(`rejects ${mode} when not unlocked (clear "enable in config" message)`, async () => {
      fx = await makeRepoFixture();
      withEnv(undefined); // explicitly locked
      const rt = await createRuntime({ repoRoot: fx.root });
      await expect(
        runCastCommand(rt, {
          ...baseOpts,
          mode: mode as unknown as 'recon-swarm',
          task: 't',
          cloneCount: mode === 'council' ? 3 : 2,
          runner: runFakeCloneScript({ scriptPath: fixturePath }),
          castId: `cast-${mode}-locked`,
          dryRun: true,
        }),
      ).rejects.toMatchObject({
        name: 'CliError',
        kind: 'invalid_input',
        message: expect.stringContaining('MANTA_UNLOCK_AGHS') as unknown as string,
      });
    });
  }

  it('unlocks decoy via MANTA_UNLOCK_AGHS env (dry-run passes the gate)', async () => {
    fx = await makeRepoFixture();
    withEnv('decoy');
    const rt = await createRuntime({ repoRoot: fx.root });
    const result = await runCastCommand(rt, {
      ...baseOpts,
      mode: 'decoy' as unknown as 'recon-swarm',
      task: 'draft a README outline',
      cloneCount: 2,
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      castId: 'cast-decoy-env',
      dryRun: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Dry run complete');
  });

  it('unlocks council via the "all" wildcard (dry-run passes the gate)', async () => {
    fx = await makeRepoFixture();
    withEnv('all');
    const rt = await createRuntime({ repoRoot: fx.root });
    const result = await runCastCommand(rt, {
      ...baseOpts,
      mode: 'council' as unknown as 'recon-swarm',
      task: 'propose a caching strategy',
      cloneCount: 3,
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      castId: 'cast-council-all',
      dryRun: true,
    });
    expect(result.exitCode).toBe(0);
  });

  it('unlocks decoy via .manta/config/budget.json aghs.unlocked (no env)', async () => {
    fx = await makeRepoFixture();
    withEnv(undefined);
    const cfgDir = path.join(fx.root, '.manta', 'config');
    await fs.mkdir(cfgDir, { recursive: true });
    await fs.writeFile(
      path.join(cfgDir, 'budget.json'),
      JSON.stringify({ aghs: { unlocked: ['decoy'] } }),
    );
    const rt = await createRuntime({ repoRoot: fx.root });
    const result = await runCastCommand(rt, {
      ...baseOpts,
      mode: 'decoy' as unknown as 'recon-swarm',
      task: 'draft',
      cloneCount: 2,
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      castId: 'cast-decoy-cfg',
      dryRun: true,
    });
    expect(result.exitCode).toBe(0);
  });

  it('config unlock of decoy does NOT unlock council (per-mode granularity)', async () => {
    fx = await makeRepoFixture();
    withEnv(undefined);
    const cfgDir = path.join(fx.root, '.manta', 'config');
    await fs.mkdir(cfgDir, { recursive: true });
    await fs.writeFile(
      path.join(cfgDir, 'budget.json'),
      JSON.stringify({ aghs: { unlocked: ['decoy'] } }),
    );
    const rt = await createRuntime({ repoRoot: fx.root });
    await expect(
      runCastCommand(rt, {
        ...baseOpts,
        mode: 'council' as unknown as 'recon-swarm',
        task: 't',
        cloneCount: 3,
        runner: runFakeCloneScript({ scriptPath: fixturePath }),
        castId: 'cast-council-still-locked',
        dryRun: true,
      }),
    ).rejects.toMatchObject({ kind: 'invalid_input' });
  });

  it('rejects decoy with > 2 clones (even when unlocked)', async () => {
    fx = await makeRepoFixture();
    withEnv('decoy');
    const rt = await createRuntime({ repoRoot: fx.root });
    await expect(
      runCastCommand(rt, {
        ...baseOpts,
        mode: 'decoy' as unknown as 'recon-swarm',
        task: 't',
        cloneCount: 3,
        runner: runFakeCloneScript({ scriptPath: fixturePath }),
        castId: 'cast-decoy-toomany',
        dryRun: true,
      }),
    ).rejects.toMatchObject({
      kind: 'invalid_input',
      message: expect.stringContaining('decoy mode supports at most 2') as unknown as string,
    });
  });

  it('rejects council with < 3 or > 5 clones (even when unlocked)', async () => {
    fx = await makeRepoFixture();
    withEnv('council');
    const rt = await createRuntime({ repoRoot: fx.root });
    for (const n of [2]) {
      await expect(
        runCastCommand(rt, {
          ...baseOpts,
          mode: 'council' as unknown as 'recon-swarm',
          task: 't',
          cloneCount: n,
          runner: runFakeCloneScript({ scriptPath: fixturePath }),
          castId: `cast-council-${n}`,
          dryRun: true,
        }),
      ).rejects.toMatchObject({
        kind: 'invalid_input',
        message: expect.stringContaining('council mode requires 3-5') as unknown as string,
      });
    }
  });

  it('decoy: full spawn wires drafter approachHint + collaborative (allowed) policy', async () => {
    fx = await makeRepoFixture();
    withEnv('decoy');
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: { heartbeatTimeoutMs: 100, startupGraceMs: 100, parentPidCheckEnabled: false },
    });
    const result = await runCastCommand(rt, {
      ...baseOpts,
      mode: 'decoy' as unknown as 'recon-swarm',
      task: 'draft an outline',
      cloneCount: 2,
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      castId: 'cast-decoy-spawn',
    });
    expect(result.exitCode).toBe(0);
    // Manifest pins the collaborative policy.
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(fx.root, '.manta', 'state', 'casts', 'cast-decoy-spawn.json'),
        'utf-8',
      ),
    ) as { mode: Mode; policy: { peer_messaging: string } };
    expect(manifest.mode).toBe('decoy');
    expect(manifest.policy.peer_messaging).toBe('allowed');
    // Snapshot carries the drafter approachHint.
    const snap = JSON.parse(
      await fs.readFile(
        path.join(fx.root, '.manta', 'snapshots', 'cast-decoy-spawn', 'A.snapshot.json'),
        'utf-8',
      ),
    ) as { taskContract: { approachHint: string | null } };
    expect(snap.taskContract.approachHint).toBe('drafter');
    // Worktrees created (cast-scoped path).
    for (const id of ['A', 'B']) {
      const wt = cloneWorktreePath(fx.root, 'cast-decoy-spawn', id);
      await expect(fs.access(wt)).resolves.toBeUndefined();
    }
  });

  it('council: full spawn wires proposer approachHint + independent (denied) policy', async () => {
    fx = await makeRepoFixture();
    withEnv('council');
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: { heartbeatTimeoutMs: 100, startupGraceMs: 100, parentPidCheckEnabled: false },
    });
    const result = await runCastCommand(rt, {
      ...baseOpts,
      mode: 'council' as unknown as 'recon-swarm',
      task: 'propose a strategy',
      cloneCount: 3,
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      castId: 'cast-council-spawn',
    });
    expect(result.exitCode).toBe(0);
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(fx.root, '.manta', 'state', 'casts', 'cast-council-spawn.json'),
        'utf-8',
      ),
    ) as { mode: Mode; policy: { peer_messaging: string; auto_merge_threshold: number | null } };
    expect(manifest.mode).toBe('council');
    // Independent proposers: messaging denied, but NO auto-merge (main aggregates).
    expect(manifest.policy.peer_messaging).toBe('denied');
    expect(manifest.policy.auto_merge_threshold).toBeNull();
    const snap = JSON.parse(
      await fs.readFile(
        path.join(fx.root, '.manta', 'snapshots', 'cast-council-spawn', 'A.snapshot.json'),
        'utf-8',
      ),
    ) as { taskContract: { approachHint: string | null } };
    expect(snap.taskContract.approachHint).toBe('proposer');
  });
});
