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

describe.skipIf(noClaude)('refactor-wave end-to-end against real claude', () => {
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
        `[refactor-wave.e2e] preserving evidence at ${fx.root} (${
          force ? 'MANTA_E2E_KEEP=1' : 'test failed'
        }) — inspect docs/post-mortems, docs/merge-all-reports, .manta/state, .manta/worktrees`,
      );
      return;
    }
    await fx.cleanup();
  });

  it('runs a 2-clone refactor-wave with disjoint partitions, merge-all report, forensic timeline, and charges', async () => {
    fx = await makeSampleRepo();

    const tasksYaml = path.join(fx.root, 'tasks.yaml');
    await fs.writeFile(
      tasksYaml,
      [
        'A:',
        "  task: 'Migrate src/auth.ts to use Result<T> instead of throwing'",
        "  approach_hint: 'Replace try/catch with Result.ok/Result.err pattern'",
        '  scope:',
        '    allowed_paths:',
        '      - src/auth.ts',
        '    forbidden_paths:',
        '      - .manta/state',
        '      - secrets/',
        '    max_files_changed: 5',
        'B:',
        "  task: 'Migrate src/utils.ts to use Result<T> instead of throwing'",
        "  approach_hint: 'Replace try/catch with Result.ok/Result.err pattern'",
        '  scope:',
        '    allowed_paths:',
        '      - src/utils.ts',
        '    forbidden_paths:',
        '      - .manta/state',
        '      - secrets/',
        '    max_files_changed: 5',
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
        cliBin, 'cast', 'refactor-wave',
        '--clones', String(expectedCloneCount),
        '--task', 'Migrate error handling from throw to Result<T> pattern.',
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

    // ── Merge-all report (not merge-review) ─────────────────────────────
    // After Clone A's merge-all.ts lands, the report appears at
    // docs/merge-all-reports/cast-<id>.md. Until then, we verify NO
    // merge-review events were emitted.
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
    expect(firstEntry.cast_id).toBe(observedCastId);

    // ── Charge system recorded cost ─────────────────────────────────────
    const chargesPath = path.join(fx.root, '.manta', 'state', 'charges.json');
    const chargesRaw = await fs.readFile(chargesPath, 'utf-8');
    const chargesState = JSON.parse(chargesRaw) as {
      current_charges: number;
      total_casts: number;
    };
    expect(chargesState.total_casts).toBeGreaterThanOrEqual(1);
  }, 28 * 60 * 1000);
});
