import { describe, it, expect, afterEach } from 'vitest';
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
});
