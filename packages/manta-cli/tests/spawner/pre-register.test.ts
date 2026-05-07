import { describe, it, expect, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  spawnClone,
  runFakeCloneScript,
  type CloneRunner,
} from '../../src/spawner/clone-spawner.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';
import { makeRegistryFake } from '../helpers/registryFake.js';
import { makeSnapshotFor } from '../helpers/snapshotFixture.js';

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'fake-clone.mjs',
);

describe('spawnClone — pre-registration (Phase-1 lockdown, closes manta-bugs #2)', () => {
  let fx: RepoFixture | undefined;
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  it('writes a registry record before invoking the runner', async () => {
    fx = await makeRepoFixture();
    const events: string[] = [];
    const registry = makeRegistryFake({ onRegister: () => { events.push('register'); } });
    const runner: CloneRunner = {
      run: vi.fn(() => {
        events.push('run');
        return runFakeCloneScript({ scriptPath: fixturePath }).run({
          cwd: fx!.root,
          env: { MANTA_SNAPSHOT_PATH: '/tmp/x', MANTA_REPO_ROOT: fx!.root, MANTA_CLONE_ID: 'A' },
          appendSystemPrompt: 'preamble',
          prompt: 'task',
        });
      }),
    };

    const handle = await spawnClone({
      repoRoot: fx.root,
      snapshot: makeSnapshotFor({ cloneId: 'A', castId: 'cast-X' }),
      worktree: fx.root,
      runner,
      registry,
    });
    await handle.exit;

    expect(events).toEqual(['register', 'run']);
    expect(registry.records).toHaveLength(1);
    expect(registry.records[0]).toMatchObject({
      clone_id: 'A',
      state: 'STARTING',
      metadata: { cast_id: 'cast-X' },
    });
  });

  it('awaits register completion before launching runner (slow-register guard)', async () => {
    fx = await makeRepoFixture();
    const order: string[] = [];
    const slowRegister = makeRegistryFake({
      onRegister: () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            order.push('register');
            resolve();
          }, 50),
        ),
    });
    const runner: CloneRunner = {
      run: vi.fn(() => {
        order.push('run');
        return runFakeCloneScript({ scriptPath: fixturePath }).run({
          cwd: fx!.root,
          env: { MANTA_SNAPSHOT_PATH: '/tmp/x', MANTA_REPO_ROOT: fx!.root, MANTA_CLONE_ID: 'B' },
          appendSystemPrompt: 'preamble',
          prompt: 'task',
        });
      }),
    };

    const handle = await spawnClone({
      repoRoot: fx.root,
      snapshot: makeSnapshotFor({ cloneId: 'B' }),
      worktree: fx.root,
      runner,
      registry: slowRegister,
    });
    await handle.exit;

    // The register callback completed BEFORE runner.run was called.
    expect(order[0]).toBe('register');
    expect(order[1]).toBe('run');
  });

  it('does not invoke the runner if registry.register throws', async () => {
    fx = await makeRepoFixture();
    const runner: CloneRunner = {
      run: vi.fn(() =>
        runFakeCloneScript({ scriptPath: fixturePath }).run({
          cwd: fx!.root,
          env: { MANTA_SNAPSHOT_PATH: '/tmp/x', MANTA_REPO_ROOT: fx!.root, MANTA_CLONE_ID: 'C' },
          appendSystemPrompt: '',
          prompt: '',
        }),
      ),
    };
    const registry = makeRegistryFake({
      onRegister: () => {
        throw new Error('boom');
      },
    });

    await expect(
      spawnClone({
        repoRoot: fx.root,
        snapshot: makeSnapshotFor({ cloneId: 'C' }),
        worktree: fx.root,
        runner,
        registry,
      }),
    ).rejects.toMatchObject({
      name: 'CliError',
      kind: 'register_failed',
    });

    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock pattern; runner.run does not access `this`
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('passes priming text via runner input.appendSystemPrompt and input.prompt', async () => {
    fx = await makeRepoFixture();
    let captured: { appendSystemPrompt: string; prompt: string } | undefined;
    const runner: CloneRunner = {
      run: (input) => {
        captured = { appendSystemPrompt: input.appendSystemPrompt, prompt: input.prompt };
        return runFakeCloneScript({ scriptPath: fixturePath }).run(input);
      },
    };

    const handle = await spawnClone({
      repoRoot: fx.root,
      snapshot: makeSnapshotFor({
        cloneId: 'D',
        castId: 'cast-D',
        task: 'investigate ./src/auth',
      }),
      worktree: fx.root,
      runner,
      registry: makeRegistryFake(),
    });
    await handle.exit;

    expect(captured?.appendSystemPrompt).toContain('manta-as-clone');
    expect(captured?.appendSystemPrompt).toContain('D'); // clone_id
    expect(captured?.prompt).toContain('Task:');
    expect(captured?.prompt).toContain('investigate ./src/auth');
  });
});
