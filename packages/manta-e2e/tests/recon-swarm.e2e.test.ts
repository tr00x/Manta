import { describe, it, expect, afterAll, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { probeClaudeBin } from './helpers/claudeBin.js';
import { makeSampleRepo, type SampleRepoFixture } from './helpers/sampleRepo.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cliBin = path.join(repoRoot, 'packages/manta-cli/dist/bin/manta.cjs');

// NOTE: this suite proves the *harness* — that the spawn / bus / orchestrator /
// CLI / skills wiring carries a real `claude --print` clone through its full
// lifecycle and produces every expected on-disk artifact. It does NOT assert
// the *quality* of the answer the clone produced (e.g. that `docs/recon.md`
// usefully maps the codebase). Output-quality assessment is the human's job
// in `docs/acceptance/phase-0.md`.
//
// Probe once at module load so the skip is VISIBLE in the reporter. A suite-level
// `describe.skipIf` reports as skipped (not a zero-assertion pass), so green CI can
// distinguish a real armed run from a no-op when claude is absent (H1).
const claude = await probeClaudeBin();
const noClaude = !claude.available;

describe.skipIf(noClaude)('recon-swarm end-to-end against real claude', () => {
  let fx: SampleRepoFixture | undefined;
  // Preserve-evidence: when a test in this suite fails, keep the tmp repo so
  // the dogfood post-mortems / ZK notes / registry / worktrees are inspectable.
  // Set MANTA_E2E_KEEP=1 to force-retain even on success.
  let suiteFailed = false;

  afterEach((ctx) => {
    if (ctx.task.result?.state === 'fail') suiteFailed = true;
  });

  afterAll(async () => {
    if (!fx) return;
    const force = process.env.MANTA_E2E_KEEP === '1';
    if (suiteFailed || force) {
      // eslint-disable-next-line no-console -- forensics signal for the human running the dogfood
      console.warn(
        `[recon-swarm.e2e] preserving evidence at ${fx.root} (${
          force ? 'MANTA_E2E_KEEP=1' : 'test failed'
        }) — inspect docs/post-mortems, docs/zk, .manta/state, .manta/worktrees`,
      );
      return;
    }
    await fx.cleanup();
  });

  it('runs a 2-clone recon-swarm cast and produces post-mortems and ZK notes', async () => {
    fx = await makeSampleRepo();
    // Phase-1 lockdown: positive-timeline guard. Bug #3 was a 30-min vitest hang
    // because clones never moved past STARTING. With pre-registration + correct
    // transport, every clone must transition off STARTING within tickBudgetMs/4
    // (heartbeat indicates real liveness; last_heartbeat_at alone cannot prove it,
    // it's stamped at register time).
    const tickBudgetMs = 1_500_000; // 25 min ceiling — keep in lockstep with --tick-budget-ms below
    const heartbeatBudgetMs = tickBudgetMs / 4; // 6m15s positive-liveness budget
    const expectedCloneCount = 2;

    const castProc = execa(
      'node',
      [
        cliBin, 'cast', 'recon-swarm',
        '--clones', String(expectedCloneCount),
        '--task', 'Map every public export in src/. Produce a markdown summary as docs/recon.md.',
        '--cycle-interval-ms', '5000',
        '--tick-budget-ms', String(tickBudgetMs),
      ],
      { cwd: fx.root, reject: false, timeout: 28 * 60 * 1000 },
    );

    const { busPaths, Registry, systemClock } = await import('@manta/bus');
    const watcherRegistry = new Registry(busPaths(fx.root), systemClock);

    // Forensic timeline: poll Registry every 5s for the full cast lifecycle
    // (not just until STARTING transitions). Persist polls + milestones to
    // docs/post-mortems/e2e-timeline-<cast-id>.json so wall-time and per-state
    // transitions are auditable after the fact (see post-mortem 2026-05-07).
    const timelinePolls: Array<{
      ts: number;
      elapsed_ms: number;
      clones: Array<{
        id: string;
        state: string;
        last_heartbeat_at: number;
        metadata: Record<string, string>;
        progress: string | undefined;
        death_reason: string | undefined;
        died_at: number | undefined;
      }>;
    }> = [];
    let observedCastId: string | undefined;
    let metStartingMilestone = false;
    const startedAt = Date.now();

    const timelineRecorder = (async () => {
      while (castProc.exitCode == null && Date.now() - startedAt < tickBudgetMs) {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        let clones;
        try {
          clones = await watcherRegistry.list();
        } catch {
          continue; // registry file may not yet exist on first ticks
        }
        timelinePolls.push({
          ts: Date.now(),
          elapsed_ms: Date.now() - startedAt,
          clones: clones.map((c) => ({
            id: c.clone_id,
            state: c.state,
            last_heartbeat_at: c.last_heartbeat_at,
            metadata: c.metadata,
            progress: c.progress,
            death_reason: c.death_reason,
            died_at: c.died_at,
          })),
        });
        if (!observedCastId) {
          const withCast = clones.find((c) => typeof c.metadata?.cast_id === 'string');
          if (withCast) observedCastId = withCast.metadata.cast_id;
        }
        if (
          !metStartingMilestone &&
          clones.length === expectedCloneCount &&
          clones.every((c) => c.state !== 'STARTING')
        ) {
          metStartingMilestone = true;
        }
        if (!metStartingMilestone && Date.now() - startedAt >= heartbeatBudgetMs) {
          // Positive-timeline budget exceeded before any clone left STARTING.
          // Dump registry, kill cast, fail loudly. (Bug #3 regression guard.)
          let final;
          try {
            final = await watcherRegistry.list();
          } catch (e) {
            final = `<registry unreadable: ${(e as Error).message}>`;
          }
          castProc.kill('SIGTERM');
          throw new Error(
            `e2e timeline assertion: not all clones transitioned off STARTING within ${heartbeatBudgetMs}ms; registry=${JSON.stringify(final)}`,
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
        // castProc already rejected; recorderError will be thrown below
      }
    }

    // Always persist the timeline JSON — independent of pass/fail. Goes under
    // the sample repo's docs/post-mortems/ so afterAll's preserve-on-failure
    // hook keeps it alongside the clone post-mortems.
    const timelineFinishedAt = Date.now();
    const timelineDir = path.join(fx.root, 'docs', 'post-mortems');
    await fs.mkdir(timelineDir, { recursive: true });
    const timelineFile = path.join(
      timelineDir,
      `e2e-timeline-${observedCastId ?? `unknown-${startedAt}`}.json`,
    );
    await fs.writeFile(
      timelineFile,
      JSON.stringify(
        {
          cast_id: observedCastId ?? null,
          expected_clone_count: expectedCloneCount,
          started_at: startedAt,
          finished_at: timelineFinishedAt,
          duration_ms: timelineFinishedAt - startedAt,
          positive_timeline_met: metStartingMilestone,
          cast_exit_code: r?.exitCode ?? null,
          polls: timelinePolls,
        },
        null,
        2,
      ),
    );

    if (recorderError) throw recorderError;
    if (!r) throw new Error('cast process did not produce a result');

    // Surface stdout/stderr on failure for diagnosis
    if (r.exitCode !== 0) {
      console.error('cast stdout:\n', r.stdout);
      console.error('cast stderr:\n', r.stderr);
    }
    expect(r.exitCode).toBe(0);

    // Both clones reached DEAD via the orchestrator. Use the public Registry API
    // (not raw JSON) so this assertion stays correct if the on-disk shape evolves.
    // (Reuse the watcherRegistry instance built above for the timeline assertion.)
    const clones = await watcherRegistry.list();
    expect(clones).toHaveLength(2);
    for (const c of clones) {
      expect(c.state).toBe('DEAD');
    }

    // Post-mortems on disk — at least 2 (orchestrator may write more if recover ran)
    const pmDir = path.join(fx.root, 'docs/post-mortems');
    const pmFiles = (await fs.readdir(pmDir)).filter((f) => f.endsWith('.md'));
    expect(pmFiles.length).toBeGreaterThanOrEqual(2);
    expect(pmFiles.some((f) => f.endsWith('-A.md'))).toBe(true);
    expect(pmFiles.some((f) => f.endsWith('-B.md'))).toBe(true);
    for (const f of pmFiles) {
      const body = await fs.readFile(path.join(pmDir, f), 'utf8');
      expect(body).toContain('# Post-mortem — clone');
      expect(body).toContain('## Event timeline');
    }

    // Each clone wrote at least one ZK note (1-3 per manta-graceful-death skill).
    // Phase-1 v0.0.2 of the skill made ZK writes required; bug #5 closed.
    const zkDir = path.join(fx.root, 'docs/zk');
    const zkFiles = (await fs.readdir(zkDir)).filter((f) => f.endsWith('.md'));
    expect(zkFiles.length).toBeGreaterThanOrEqual(2);

    // Snapshots persisted under at least one cast directory
    const snapDirs = (await fs.readdir(path.join(fx.root, '.manta/snapshots')))
      .filter((d) => d.startsWith('cast-'));
    expect(snapDirs.length).toBeGreaterThanOrEqual(1);
    const snaps = await fs.readdir(path.join(fx.root, '.manta/snapshots', snapDirs[0]!));
    expect(snaps).toContain('A.snapshot.json');
    expect(snaps).toContain('B.snapshot.json');

    // Worktrees retained
    for (const id of ['A', 'B']) {
      const wt = path.join(fx.root, '.manta/worktrees', `clone-${id}`);
      await expect(fs.access(wt)).resolves.toBeUndefined();
    }
  }, 28 * 60 * 1000);
});
