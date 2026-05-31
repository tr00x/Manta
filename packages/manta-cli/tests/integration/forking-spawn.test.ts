import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runCastCommand } from '../../src/commands/cast.js';
import { runFakeCloneScript } from '../../src/spawner/clone-spawner.js';
import { createRuntime } from '../../src/runtime.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'fake-clone.mjs',
);

describe('forking-realities spawn integration', () => {
  let fx: RepoFixture | undefined;
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  it('spawns 2 clones with distinct assignments; manifest exists; metadata.cast_mode set', async () => {
    fx = await makeRepoFixture('manta-fr-int-');
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: {
        heartbeatTimeoutMs: 100,
        startupGraceMs: 100,
        parentPidCheckEnabled: false,
      },
    });
    const result = await runCastCommand(rt, {
      mode: 'forking-realities',
      task: 'irrelevant — overridden per-clone',
      cloneCount: 2,
      cycleIntervalMs: 50,
      tickBudgetMs: 30_000,
      castId: 'cast-int-fr-1',
      internalTokenEstimatePerClone: 1,
      internalTokenEstimatePerCast: 5,
      cloneAssignments: {
        A: { task: 'algorithm-only' },
        B: { task: 'index-based', approach_hint: 'orders.customer_id' },
      },
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      reporter: { info: () => {}, warn: () => {}, error: () => {} },
      verifyMcp: false,
    });
    expect(result.exitCode).toBe(0);

    // 1. Cast manifest exists with both clones + forking-realities policy.
    const manifestPath = path.join(
      fx.root,
      '.manta',
      'state',
      'casts',
      'cast-int-fr-1.json',
    );
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      mode: string;
      policy: { peer_messaging: string };
      clones: Array<{ clone_id: string; assignment: { task?: string } | null }>;
    };
    expect(manifest.mode).toBe('forking-realities');
    expect(manifest.policy.peer_messaging).toBe('denied');
    expect(manifest.clones.map((c) => c.clone_id).sort()).toEqual(['A', 'B']);
    // The assignment field carries the per-clone overlay verbatim — Phase 2c
    // merge-review reads it via CastsStore.read.
    const aEntry = manifest.clones.find((c) => c.clone_id === 'A')!;
    const bEntry = manifest.clones.find((c) => c.clone_id === 'B')!;
    expect(aEntry.assignment).toEqual({ task: 'algorithm-only' });
    expect(bEntry.assignment).toEqual({
      task: 'index-based',
      approach_hint: 'orders.customer_id',
    });

    // 2. Each clone's registry record carries cast_mode + cast_id (the join
    // keys Phase 2b's bus filter uses without round-tripping the manifest).
    const all = await rt.ctx.registry.list();
    expect(all.length).toBe(2);
    for (const c of all) {
      expect(c.metadata.cast_mode).toBe('forking-realities');
      expect(c.metadata.cast_id).toBe('cast-int-fr-1');
    }

    // 3. Each clone's contract reflects its assignment (snake_case wire form).
    const aStored = await rt.ctx.contracts.read('A');
    const bStored = await rt.ctx.contracts.read('B');
    expect(aStored.contract.task).toBe('algorithm-only');
    expect(bStored.contract.task).toBe('index-based');
    expect(bStored.contract.approach_hint).toBe('orders.customer_id');
    // Sibling roster stays consistent (Phase 2b filter join key).
    expect(aStored.contract.sibling_clones).toEqual(['B']);
    expect(bStored.contract.sibling_clones).toEqual(['A']);
  });
});
