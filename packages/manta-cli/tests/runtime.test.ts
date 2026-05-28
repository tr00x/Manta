import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRuntime } from '../src/runtime.js';
import { makeRepoFixture, type RepoFixture } from './helpers/repoFixture.js';

describe('runtime', () => {
  let fx: RepoFixture | undefined;
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  it('createRuntime builds a Runtime around the repo cwd', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    expect(rt.repoRoot).toBe(fx.root);
    expect(rt.ctx.paths.repoRoot).toBe(fx.root);
    expect(rt.thresholds.heartbeatTimeoutMs).toBeGreaterThan(0);
    expect(rt.orchestrator).toBeDefined();
    await rt.dispose();
  });

  // Bug #20 regression — runtime must wire WorkQueueStore into ctx. Without
  // this, Phase 5/6 daemon-mode features (pair-programming, test-storm,
  // documentation-chase) and the retask command silently no-op in
  // production because they short-circuit on `if (rt.ctx.workQueue)`.
  it('createRuntime wires WorkQueueStore into ctx (regression: bug #20)', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    expect(rt.ctx.workQueue).toBeDefined();
    const item = await rt.ctx.workQueue!.enqueue({
      cast_id: 'cast-rt-1',
      target_clone_id: 'A',
      prompt: 'hello',
      priority: 'normal',
    });
    expect(item.id).toMatch(/^wq-/);
    const pending = await rt.ctx.workQueue!.pending('A');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.prompt).toBe('hello');
    await rt.dispose();
  });

  it('createRuntime accepts threshold overrides', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: { heartbeatTimeoutMs: 90_000 },
    });
    expect(rt.thresholds.heartbeatTimeoutMs).toBe(90_000);
    await rt.dispose();
  });

  it('createRuntime ensures the .manta/state directory exists', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    const exists = await import('node:fs/promises').then((fs) =>
      fs
        .access(`${fx!.root}/.manta/state`)
        .then(() => true)
        .catch(() => false),
    );
    expect(exists).toBe(true);
    await rt.dispose();
  });

  // I-3 regression: createRuntime rejects non-git directories with invalid_input
  // before scribbling .manta/state into a random folder.
  it('createRuntime rejects a directory that is not a git repo', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-cli-not-a-repo-'));
    try {
      await expect(createRuntime({ repoRoot: dir })).rejects.toMatchObject({
        name: 'CliError',
        kind: 'invalid_input',
        message: expect.stringContaining('not a git repo root') as unknown as string,
      });
      // .manta/state must NOT have been created.
      await expect(fs.access(path.join(dir, '.manta'))).rejects.toBeDefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
