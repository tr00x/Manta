import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runCastCommand } from '../src/commands/cast.js';
import { runFakeCloneScript } from '../src/spawner/clone-spawner.js';
import { createReporter, MemorySink } from '../src/output/reporter.js';
import { createRuntime } from '../src/runtime.js';
import { makeRepoFixture, type RepoFixture } from './helpers/repoFixture.js';

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-clone.mjs',
);

describe('cli end-to-end (recon-swarm with fake clones)', () => {
  let fx: RepoFixture | undefined;
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  it('cast → spawn → fake-clone exits without DEAD → orchestrator detects + writes post-mortem', async () => {
    fx = await makeRepoFixture();
    // Override heartbeatTimeoutMs to a tiny value so the orchestrator's
    // death-detector fires within the cast's tick window. Without this, the
    // default 30s threshold would force the test to wait too long.
    // parentPidCheckEnabled disabled because the fake-clone records ppid =
    // the test runner (whose PID exists at first sweep but isn't the real
    // parent of the fake clone).
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: {
        heartbeatTimeoutMs: 500,
        startupGraceMs: 500,
        parentPidCheckEnabled: false,
      },
    });
    const sink = new MemorySink();
    const result = await runCastCommand(rt, {
      mode: 'recon-swarm',
      task: 'map src/',
      cloneCount: 2,
      cycleIntervalMs: 50,
      tickBudgetMs: 15_000,
      castId: 'cast-it-1',
      budgetUsdPerClone: 5,
      budgetUsdPerCast: 15,
      verifyMcp: false,
      // Default fake-clone behaviour ('crash' mode) is: register, exit 0
      // WITHOUT marking DEAD — exercises the orchestrator's death-detection.
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      reporter: createReporter({ sink }),
    });
    expect(result.exitCode).toBe(0);

    // Both clones ended up DEAD via the orchestrator (not via the fake fixture).
    const reg = await rt.ctx.registry.list();
    expect(reg).toHaveLength(2);
    for (const r of reg) {
      expect(r.state).toBe('DEAD');
      // Orchestrator's death-detector stamps a heartbeat-derived reason
      // (see @manta/orchestrator/src/death-detector.ts).
      expect(r.death_reason).toMatch(/heartbeat/i);
    }

    // Snapshots written under .manta/snapshots/<cast>/<clone>.snapshot.json.
    for (const id of ['A', 'B']) {
      const snap = path.join(
        fx.root,
        '.manta',
        'snapshots',
        'cast-it-1',
        `${id}.snapshot.json`,
      );
      await expect(fs.access(snap)).resolves.toBeUndefined();
    }

    // Post-mortem markdown landed on disk for each clone — proves the
    // orchestrator's runPostMortem ran inside the cast's tick loop.
    const pmDir = path.join(fx.root, 'docs', 'post-mortems');
    const pmFiles = await fs.readdir(pmDir);
    expect(pmFiles.length).toBe(2);
    expect(pmFiles.some((f) => f.endsWith('-A.md'))).toBe(true);
    expect(pmFiles.some((f) => f.endsWith('-B.md'))).toBe(true);

    // Reporter captured key events.
    const events = sink.lines.map((l) => l.event);
    expect(events).toContain('cast.spawn');
    expect(events).toContain('cast.done');

    // Bus task contracts on disk reflect the snake_case wire shape.
    const contractA = await rt.ctx.contracts.read('A');
    expect(contractA.contract.clone_id).toBe('A');
    expect(contractA.contract.deadline_ms).toBeGreaterThan(0);
    expect(contractA.contract.scope.allowed_paths).toEqual(['.']);
  });
});
