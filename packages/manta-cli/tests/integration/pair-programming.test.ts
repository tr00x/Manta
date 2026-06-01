import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Snapshot } from '@manta/snapshot';
import { runCastCommand } from '../../src/commands/cast.js';
import {
  runFakeCloneScript,
  type CloneRunner,
} from '../../src/spawner/clone-spawner.js';
import { createReporter, MemorySink } from '../../src/output/reporter.js';
import { createRuntime } from '../../src/runtime.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'fake-clone.mjs',
);

describe('pair-programming dispatch integration', () => {
  let fx: RepoFixture | undefined;
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  it('pair-programming cast assigns writer/reviewer roles to clones', async () => {
    fx = await makeRepoFixture('manta-pair-int-');
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: {
        heartbeatTimeoutMs: 100,
        startupGraceMs: 100,
        parentPidCheckEnabled: false,
      },
    });
    const realRunner = runFakeCloneScript({ scriptPath: fixturePath });
    const captured: Snapshot[] = [];
    const recordingRunner: CloneRunner = {
      run(input) {
        const raw = readFileSync(input.env.MANTA_SNAPSHOT_PATH!, 'utf-8');
        captured.push(JSON.parse(raw) as Snapshot);
        return realRunner.run(input);
      },
    };
    const sink = new MemorySink();
    const result = await runCastCommand(rt, {
      mode: 'pair-programming' as unknown as 'recon-swarm',
      task: 'implement auth module with pair review',
      cloneCount: 2,
      cycleIntervalMs: 50,
      tickBudgetMs: 15_000,
      castId: 'cast-pair-int-1',
      runner: recordingRunner,
      reporter: createReporter({ sink }),
      verifyMcp: false,
    });
    expect(result.exitCode).toBe(0);

    const events = sink.lines.map((l) => l.event);
    expect(events).toContain('cast.spawn');
    expect(events).toContain('cast.done');
  });

  it('pair-programming sets session_mode=daemon and peer_messaging=allowed', async () => {
    fx = await makeRepoFixture('manta-pair-policy-');
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: {
        heartbeatTimeoutMs: 100,
        startupGraceMs: 100,
        parentPidCheckEnabled: false,
      },
    });
    await runCastCommand(rt, {
      mode: 'pair-programming' as unknown as 'recon-swarm',
      task: 'implement auth',
      cloneCount: 2,
      cycleIntervalMs: 50,
      tickBudgetMs: 15_000,
      castId: 'cast-pair-policy-int',
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      reporter: createReporter({ sink: new MemorySink() }),
      verifyMcp: false,
    });
    const manifestPath = path.join(fx.root, '.manta', 'state', 'casts', 'cast-pair-policy-int.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      mode: string;
      policy: { session_mode: string; peer_messaging: string };
    };
    expect(manifest.policy.session_mode).toBe('daemon');
    expect(manifest.policy.peer_messaging).toBe('allowed');
  });
});

describe('documentation-chase dispatch integration', () => {
  let fx: RepoFixture | undefined;
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  it('documentation-chase cast spawns and completes', async () => {
    fx = await makeRepoFixture('manta-doc-int-');
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
      mode: 'documentation-chase' as unknown as 'recon-swarm',
      task: 'Document modules: packages/manta-bus/src/state/registry.ts, packages/manta-cli/src/commands/cast.ts',
      cloneCount: 1,
      cycleIntervalMs: 50,
      tickBudgetMs: 15_000,
      castId: 'cast-doc-int-1',
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      reporter: createReporter({ sink }),
      verifyMcp: false,
    });
    expect(result.exitCode).toBe(0);
    const events = sink.lines.map((l) => l.event);
    expect(events).toContain('cast.done');
  });
});
