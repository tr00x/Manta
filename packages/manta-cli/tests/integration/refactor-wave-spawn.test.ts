import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runCastCommand } from '../../src/commands/cast.js';
import { runFakeCloneScript } from '../../src/spawner/clone-spawner.js';
import { createRuntime } from '../../src/runtime.js';
import { createReporter, MemorySink } from '../../src/output/reporter.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'fake-clone.mjs',
);

describe('refactor-wave spawn integration', () => {
  let fx: RepoFixture | undefined;
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  it('spawns 2 clones with disjoint module assignments; manifest + contracts + settlement', async () => {
    fx = await makeRepoFixture('manta-rw-int-');
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: {
        heartbeatTimeoutMs: 100,
        startupGraceMs: 100,
        parentPidCheckEnabled: false,
      },
    });
    const sink = new MemorySink();
    const result = await runCastCommand(rt, {
      mode: 'refactor-wave' as unknown as 'recon-swarm',
      task: 'migrate error classes to Result<T>',
      cloneCount: 2,
      cycleIntervalMs: 50,
      tickBudgetMs: 30_000,
      castId: 'cast-int-rw-1',
      cloneAssignments: {
        A: {
          task: 'migrate packages/auth to Result<T>',
          scope: {
            allowed_paths: ['packages/auth'],
            forbidden_paths: ['.manta/state', 'secrets/'],
            max_files_changed: 10,
          },
        },
        B: {
          task: 'migrate packages/billing to Result<T>',
          approach_hint: 'focus on payment-processor.ts first',
          scope: {
            allowed_paths: ['packages/billing'],
            forbidden_paths: ['.manta/state', 'secrets/'],
            max_files_changed: 10,
          },
        },
      },
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      reporter: createReporter({ sink }),
      verifyMcp: false,
    });
    expect(result.exitCode).toBe(0);

    // 1. Cast manifest exists with refactor-wave policy (peer_messaging = denied).
    const manifestPath = path.join(
      fx.root,
      '.manta',
      'state',
      'casts',
      'cast-int-rw-1.json',
    );
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      mode: string;
      policy: { peer_messaging: string };
      clones: Array<{ clone_id: string; assignment: Record<string, unknown> | null }>;
    };
    expect(manifest.mode).toBe('refactor-wave');
    expect(manifest.policy.peer_messaging).toBe('denied');
    expect(manifest.clones.map((c) => c.clone_id).sort()).toEqual(['A', 'B']);

    // 2. Registry records carry cast_mode=refactor-wave.
    const all = await rt.ctx.registry.list();
    expect(all.length).toBe(2);
    for (const c of all) {
      expect(c.metadata.cast_mode).toBe('refactor-wave');
      expect(c.metadata.cast_id).toBe('cast-int-rw-1');
    }

    // 3. Per-clone contracts reflect their module assignments.
    const aStored = await rt.ctx.contracts.read('A');
    const bStored = await rt.ctx.contracts.read('B');
    expect(aStored.contract.task).toBe('migrate packages/auth to Result<T>');
    expect(bStored.contract.task).toBe('migrate packages/billing to Result<T>');
    expect(bStored.contract.approach_hint).toBe('focus on payment-processor.ts first');
    expect(aStored.contract.scope.allowed_paths).toEqual(['packages/auth']);
    expect(bStored.contract.scope.allowed_paths).toEqual(['packages/billing']);
    expect(aStored.contract.sibling_clones).toEqual(['B']);
    expect(bStored.contract.sibling_clones).toEqual(['A']);

    // 4. Post-loop: merge-all attempted (or failed since Clone A hasn't
    //    created runMergeAll yet). Either event is acceptable pre-merge.
    const events = sink.lines.map((l) => l.event);
    expect(events).not.toContain('cast.merge_review');
    const hasMergeAll = events.includes('cast.merge-all') || events.includes('cast.merge-all-failed');
    expect(hasMergeAll).toBe(true);

    // 5. Settlement: charge event recorded.
    const chargeEvents = sink.lines.filter((l) => l.event === 'cast.settlement');
    expect(chargeEvents.length).toBe(1);
  });
});
