import { expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { makeSampleRepo, type SampleRepoFixture } from './sampleRepo.js';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);
const cliBin = path.join(repoRoot, 'packages/manta-cli/dist/bin/manta.cjs');

const CLONE_LETTERS = ['A', 'B', 'C', 'D', 'E'] as const;

export interface AghsCastE2eParams {
  mode: 'decoy' | 'council';
  cloneCount: number;
  task: string;
}

export interface AghsCastE2eResult {
  fixture: SampleRepoFixture;
  castId: string | undefined;
}

/**
 * Drive a full Aghs-gated cast (`decoy` / `council`) against the real `claude`
 * binary and assert the on-disk lifecycle artifacts. Proves the HARNESS — that
 * the unlock gate, mode dispatch, priming/skill wiring, spawn, and graceful
 * death all carry a real clone through to commit + post-mortem. Does NOT judge
 * the quality of the draft/proposal (that is the human's job).
 *
 * The caller is responsible for cleanup of the returned fixture (so a failing
 * suite can preserve evidence).
 */
export async function runAghsCastE2e(params: AghsCastE2eParams): Promise<AghsCastE2eResult> {
  const { mode, cloneCount, task } = params;
  const cloneIds = CLONE_LETTERS.slice(0, cloneCount);

  const fx = await makeSampleRepo();

  const tickBudgetMs = 1_500_000; // 25 min ceiling — lockstep with --tick-budget-ms
  const heartbeatBudgetMs = tickBudgetMs / 4;

  const castProc = execa(
    'node',
    [
      cliBin, 'cast', mode,
      '--clones', String(cloneCount),
      '--task', task,
      '--cycle-interval-ms', '5000',
      '--tick-budget-ms', String(tickBudgetMs),
    ],
    {
      cwd: fx.root,
      reject: false,
      timeout: 28 * 60 * 1000,
      // The Aghs unlock channel under test: env-based opt-in. Without this the
      // cast is rejected by assertAghsUnlocked before any clone spawns.
      env: { ...process.env, MANTA_UNLOCK_AGHS: mode },
    },
  );

  const { busPaths, Registry, systemClock } = await import('@manta/bus');
  const watcherRegistry = new Registry(busPaths(fx.root), systemClock);

  let observedCastId: string | undefined;
  let metStartingMilestone = false;
  const startedAt = Date.now();
  const timelinePolls: Array<{ elapsed_ms: number; clones: Array<{ id: string; state: string }> }> = [];

  const timelineRecorder = (async () => {
    while (castProc.exitCode == null && Date.now() - startedAt < tickBudgetMs) {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      let clones;
      try {
        clones = await watcherRegistry.list();
      } catch {
        continue;
      }
      timelinePolls.push({
        elapsed_ms: Date.now() - startedAt,
        clones: clones.map((c) => ({ id: c.clone_id, state: c.state })),
      });
      if (!observedCastId) {
        const withCast = clones.find((c) => typeof c.metadata?.cast_id === 'string');
        if (withCast) observedCastId = withCast.metadata.cast_id;
      }
      if (
        !metStartingMilestone &&
        clones.length === cloneCount &&
        clones.every((c) => c.state !== 'STARTING')
      ) {
        metStartingMilestone = true;
      }
      if (!metStartingMilestone && Date.now() - startedAt >= heartbeatBudgetMs) {
        let final;
        try {
          final = await watcherRegistry.list();
        } catch (e) {
          final = `<registry unreadable: ${(e as Error).message}>`;
        }
        castProc.kill('SIGTERM');
        throw new Error(
          `e2e timeline assertion (${mode}): not all clones left STARTING within ${heartbeatBudgetMs}ms; registry=${JSON.stringify(final)}`,
        );
      }
    }
  })();

  let r: Awaited<typeof castProc> | undefined;
  let recorderError: unknown;
  try {
    const settled = await Promise.all([castProc, timelineRecorder]);
    r = settled[0];
  } catch (e) {
    recorderError = e;
    try {
      r = await castProc;
    } catch {
      // castProc already rejected; recorderError thrown below
    }
  }

  if (recorderError) throw recorderError;
  if (!r) throw new Error('cast process did not produce a result');

  if (r.exitCode !== 0) {
    // eslint-disable-next-line no-console -- diagnosis on failure
    console.error(`[${mode}.e2e] cast stdout:\n`, r.stdout);
    // eslint-disable-next-line no-console -- diagnosis on failure
    console.error(`[${mode}.e2e] cast stderr:\n`, r.stderr);
  }
  expect(r.exitCode).toBe(0);

  // Every clone reached DEAD via the orchestrator.
  const clones = await watcherRegistry.list();
  expect(clones).toHaveLength(cloneCount);
  for (const c of clones) {
    expect(c.state).toBe('DEAD');
  }

  // Post-mortems on disk — one per clone (orchestrator may write more if recover ran).
  const pmDir = path.join(fx.root, 'docs/post-mortems');
  const pmFiles = (await fs.readdir(pmDir)).filter((f) => f.endsWith('.md'));
  expect(pmFiles.length).toBeGreaterThanOrEqual(cloneCount);
  for (const id of cloneIds) {
    expect(pmFiles.some((f) => f.endsWith(`-${id}.md`))).toBe(true);
  }
  for (const f of pmFiles) {
    const body = await fs.readFile(path.join(pmDir, f), 'utf8');
    expect(body).toContain('# Post-mortem — clone');
  }

  // Each clone wrote at least one ZK note (manta-graceful-death requires ≥1).
  const zkDir = path.join(fx.root, 'docs/zk');
  const zkFiles = (await fs.readdir(zkDir)).filter((f) => f.endsWith('.md'));
  expect(zkFiles.length).toBeGreaterThanOrEqual(cloneCount);

  // Snapshots persisted under the cast directory, one per clone.
  const snapDirs = (await fs.readdir(path.join(fx.root, '.manta/snapshots')))
    .filter((d) => d.startsWith('cast-'));
  expect(snapDirs.length).toBeGreaterThanOrEqual(1);
  const snaps = await fs.readdir(path.join(fx.root, '.manta/snapshots', snapDirs[0]!));
  for (const id of cloneIds) {
    expect(snaps).toContain(`${id}.snapshot.json`);
  }

  // Each clone committed a deliverable on its branch: the worktree HEAD has a
  // commit authored by the clone (graceful-death step (b)). Use git log in the
  // cast-scoped worktree (bug #64 path scheme) to confirm a real commit landed.
  const castId = observedCastId ?? snapDirs[0]!;
  for (const id of cloneIds) {
    const wt = path.join(fx.root, '.manta', 'worktrees', `clone-${castId}-${id}`);
    await expect(fs.access(wt)).resolves.toBeUndefined();
    const log = await execa('git', ['log', '--oneline', '-n', '5'], { cwd: wt, reject: false });
    expect(log.stdout).toContain(`manta-clone-${id}`);
  }

  return { fixture: fx, castId };
}
