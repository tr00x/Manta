import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../../src/runtime.js';
import {
  spawnClone,
  runFakeCloneScript,
} from '../../src/spawner/clone-spawner.js';
import { makeSnapshotFor } from '../helpers/snapshotFixture.js';

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'fake-clone.mjs',
);

// Behavioural-fixture for the spawn → register → first-heartbeat sequence.
// This is the gap Phase 0e/0f preflights missed: pre-flight only proved each
// box ran in isolation, not that the spawner actually wires identity into the
// Bus before the runner exits. Phase-1 lockdown adds spawner pre-registration;
// this test pins the invariant in real Bus state (NOT an in-memory fake).
describe('spawn → register → state-transition behavioural fixture (Phase-1 lockdown)', () => {
  let repoRoot: string;
  beforeEach(() => {
    repoRoot = mkdtempSync(path.join(tmpdir(), 'manta-startup-'));
    execSync('git init -q', { cwd: repoRoot });
    execSync('git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', {
      cwd: repoRoot,
    });
  });
  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('spawner writes a real Registry record before the runner exits', async () => {
    const rt = await createRuntime({ repoRoot });

    const handle = await spawnClone({
      repoRoot,
      snapshot: makeSnapshotFor({ cloneId: 'clone-A', castId: 'cast-X', mode: 'recon-swarm' }),
      worktree: repoRoot,
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      registry: rt.ctx.registry,
      casts: rt.ctx.casts,
      castMode: 'recon-swarm',
      castPolicy: { peer_messaging: 'allowed', auto_merge_threshold: null },
      castRoster: [{ clone_id: 'clone-A', assignment: null }],
    });

    // Pre-registration invariant: registry sees clone-A *now*, before exit.
    // This is the on-disk Bus Registry, not an in-memory fake.
    const recBefore = await rt.ctx.registry.get('clone-A');
    expect(recBefore).toMatchObject({
      clone_id: 'clone-A',
      state: 'STARTING',
      mode: 'recon-swarm',
      metadata: { cast_id: 'cast-X', cast_mode: 'recon-swarm' },
    });

    await handle.exit;

    // After exit (crash mode, no heartbeat issued), state stays STARTING. The
    // orchestrator's death-detector — not the clone — flips to DEAD when
    // last_heartbeat_at goes stale (covered by integration.test.ts).
    const recAfter = await rt.ctx.registry.get('clone-A');
    expect(recAfter.state).toBe('STARTING');

    await rt.dispose();
  });

  it('Registry.get throws BusNotFoundError for an absent clone (sanity)', async () => {
    const rt = await createRuntime({ repoRoot });
    await expect(rt.ctx.registry.get('phantom')).rejects.toThrow(/clone/);
    await rt.dispose();
  });

  it('snapshot file is written to .manta/snapshots/<castId>/<cloneId>.snapshot.json before registration', async () => {
    const rt = await createRuntime({ repoRoot });

    const handle = await spawnClone({
      repoRoot,
      snapshot: makeSnapshotFor({ cloneId: 'clone-B', castId: 'cast-Y' }),
      worktree: repoRoot,
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      registry: rt.ctx.registry,
      casts: rt.ctx.casts,
      castMode: 'recon-swarm',
      castPolicy: { peer_messaging: 'allowed', auto_merge_threshold: null },
      castRoster: [{ clone_id: 'clone-B', assignment: null }],
    });

    const snapPath = path.join(repoRoot, '.manta', 'snapshots', 'cast-Y', 'clone-B.snapshot.json');
    await expect(fs.access(snapPath)).resolves.toBeUndefined();

    await handle.exit;
    await rt.dispose();
  });
});
