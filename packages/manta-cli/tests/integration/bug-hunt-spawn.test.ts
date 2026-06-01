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

describe('bug-hunt spawn integration', () => {
  let fx: RepoFixture | undefined;
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  it('spawns 2 clones with layer assignments; manifest + registry + contracts correct; no merge-review', async () => {
    fx = await makeRepoFixture('manta-bh-int-');
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
      mode: 'bug-hunt' as unknown as 'recon-swarm',
      task: 'investigate auth timeout in src/auth.ts',
      cloneCount: 2,
      cycleIntervalMs: 50,
      tickBudgetMs: 30_000,
      castId: 'cast-int-bh-1',
      cloneAssignments: {
        A: { task: 'investigate API layer', approach_hint: 'trace request lifecycle' },
        B: { task: 'investigate DB layer', approach_hint: 'check connection pool' },
      },
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      reporter: createReporter({ sink }),
      verifyMcp: false,
    });
    expect(result.exitCode).toBe(0);

    // 1. Cast manifest: mode=bug-hunt, peer_messaging=allowed
    const manifestPath = path.join(
      fx.root,
      '.manta',
      'state',
      'casts',
      'cast-int-bh-1.json',
    );
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      mode: string;
      policy: { peer_messaging: string };
      clones: Array<{ clone_id: string; assignment: { task?: string } | null }>;
    };
    expect(manifest.mode).toBe('bug-hunt');
    expect(manifest.policy.peer_messaging).toBe('allowed');
    expect(manifest.clones.map((c) => c.clone_id).sort()).toEqual(['A', 'B']);

    // 2. Registry records carry cast_mode=bug-hunt
    const all = await rt.ctx.registry.list();
    expect(all.length).toBe(2);
    for (const c of all) {
      expect(c.metadata.cast_mode).toBe('bug-hunt');
      expect(c.metadata.cast_id).toBe('cast-int-bh-1');
    }

    // 3. Each clone's contract reflects its layer assignment
    const aStored = await rt.ctx.contracts.read('A');
    const bStored = await rt.ctx.contracts.read('B');
    expect(aStored.contract.task).toBe('investigate API layer');
    expect(aStored.contract.approach_hint).toBe('trace request lifecycle');
    expect(bStored.contract.task).toBe('investigate DB layer');
    expect(bStored.contract.approach_hint).toBe('check connection pool');
    expect(aStored.contract.sibling_clones).toEqual(['B']);
    expect(bStored.contract.sibling_clones).toEqual(['A']);

    // 4. No merge-review event emitted (bug-hunt produces investigation reports, not competing solutions)
    const events = sink.lines.map((l) => l.event);
    expect(events).not.toContain('cast.merge_review');
    expect(events).toContain('cast.bug-hunt-complete');
    expect(events).toContain('cast.settlement');
  });
});
