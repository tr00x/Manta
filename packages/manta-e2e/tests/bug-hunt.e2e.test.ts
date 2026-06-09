import { describe, it, expect, afterAll, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { probeClaudeBin } from './helpers/claudeBin.js';
import { makeSampleRepo, type SampleRepoFixture } from './helpers/sampleRepo.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cliBin = path.join(repoRoot, 'packages/manta-cli/dist/bin/manta.cjs');

// Probe once at module load so the skip is VISIBLE in the reporter. A suite-level
// `describe.skipIf` reports as skipped (not a zero-assertion pass), so green CI can
// distinguish a real armed run from a no-op when claude is absent (H1).
const claude = await probeClaudeBin();
const noClaude = !claude.available;

describe.skipIf(noClaude)('bug-hunt end-to-end against real claude', () => {
  let fx: SampleRepoFixture | undefined;
  let suiteFailed = false;

  afterEach((ctx) => {
    if (ctx.task.result?.state === 'fail') suiteFailed = true;
  });

  afterAll(async () => {
    if (!fx) return;
    const force = process.env.MANTA_E2E_KEEP === '1';
    if (suiteFailed || force) {
      console.warn(
        `[bug-hunt.e2e] preserving evidence at ${fx.root} (${
          force ? 'MANTA_E2E_KEEP=1' : 'test failed'
        }) — inspect docs/post-mortems, .manta/state, .manta/worktrees`,
      );
      return;
    }
    await fx.cleanup();
  });

  it('runs a 2-clone bug-hunt with investigation reports, no merge-review, and a forensic timeline', async () => {
    fx = await makeSampleRepo();

    const tasksYaml = path.join(fx.root, 'tasks.yaml');
    await fs.writeFile(
      tasksYaml,
      [
        'A:',
        "  task: 'Investigate the authentication timeout in src/auth.ts — focus on the API layer'",
        "  approach_hint: 'Trace the request lifecycle from route handler to auth middleware'",
        'B:',
        "  task: 'Investigate the authentication timeout in src/auth.ts — focus on the database layer'",
        "  approach_hint: 'Check connection pool exhaustion and query timeouts'",
        '',
      ].join('\n'),
      'utf8',
    );

    const tickBudgetMs = 1_500_000;
    const heartbeatBudgetMs = tickBudgetMs / 4;
    const expectedCloneCount = 2;

    const castProc = execa(
      'node',
      [
        cliBin, 'cast', 'bug-hunt',
        '--clones', String(expectedCloneCount),
        '--task', 'Investigate authentication timeout in src/auth.ts',
        '--tasks', tasksYaml,
        '--max-files-changed', '5',
        '--allowed-paths', 'src,docs',
        '--cycle-interval-ms', '5000',
        '--tick-budget-ms', String(tickBudgetMs),
      ],
      { cwd: fx.root, reject: false, timeout: 28 * 60 * 1000 },
    );

    const { busPaths, Registry, EventsLog, systemClock } = await import('@manta/bus');
    const paths = busPaths(fx.root);
    const watcherRegistry = new Registry(paths, systemClock);

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
          continue;
        }
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

    if (recorderError) throw recorderError;
    if (!r) throw new Error('cast process did not produce a result');

    if (r.exitCode !== 0) {
      console.error('cast stdout:\n', r.stdout);
      console.error('cast stderr:\n', r.stderr);
    }
    expect(r.exitCode).toBe(0);

    // ── Registry: both clones reached DEAD ──────────────────────────────
    const clones = await watcherRegistry.list();
    expect(clones).toHaveLength(2);
    for (const c of clones) {
      expect(c.state).toBe('DEAD');
    }

    // ── Post-mortems on disk ────────────────────────────────────────────
    const pmDir = path.join(fx.root, 'docs/post-mortems');
    const pmFiles = (await fs.readdir(pmDir)).filter((f) => f.endsWith('.md'));
    expect(pmFiles.length).toBeGreaterThanOrEqual(2);
    expect(pmFiles.some((f) => f.endsWith('-A.md'))).toBe(true);
    expect(pmFiles.some((f) => f.endsWith('-B.md'))).toBe(true);

    // ── NO merge-review event (bug-hunt produces investigation reports) ──
    const eventsLog = new EventsLog(paths, systemClock);
    const allEvents = await eventsLog.readAll();
    const mergeReviewEvents = allEvents.filter(
      (e) =>
        e.type === 'merge_review' &&
        (e.payload as Record<string, unknown>)?.cast_id === observedCastId,
    );
    expect(mergeReviewEvents).toHaveLength(0);

    // ── Forensic timeline exists ────────────────────────────────────────
    expect(observedCastId).toBeDefined();
    const ftPath = path.join(fx.root, '.manta/state/timelines', `${observedCastId}.ndjson`);
    const ftStat = await fs.stat(ftPath);
    expect(ftStat.isFile()).toBe(true);
    const ftBody = await fs.readFile(ftPath, 'utf8');
    const ftLines = ftBody.trim().split('\n').filter((l) => l.length > 0);
    expect(ftLines.length).toBeGreaterThanOrEqual(1);
    const firstEntry = JSON.parse(ftLines[0]!) as Record<string, unknown>;
    // The cast↔timeline link is the FILENAME (`<castId>.ndjson`, asserted above);
    // a per-line entry is a TimelineSnapshot { ts, cycleNumber, clones[] } and
    // carries NO cast_id field. Assert the snapshot shape instead.
    expect(Array.isArray(firstEntry.clones)).toBe(true);
    expect(typeof firstEntry.ts).toBe('number');
    // (Charge-system assertions removed — the budget/charges system was deleted, #M7.)
  }, 28 * 60 * 1000);
});
