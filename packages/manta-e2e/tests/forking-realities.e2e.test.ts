import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { probeClaudeBin } from './helpers/claudeBin.js';
import { makeSampleRepo, type SampleRepoFixture } from './helpers/sampleRepo.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cliBin = path.join(repoRoot, 'packages/manta-cli/dist/bin/manta.cjs');

describe('forking-realities end-to-end against real claude', () => {
  let fx: SampleRepoFixture | undefined;
  let claude: Awaited<ReturnType<typeof probeClaudeBin>>;
  let suiteFailed = false;

  beforeAll(async () => {
    claude = await probeClaudeBin();
  });

  afterEach((ctx) => {
    if (ctx.task.result?.state === 'fail') suiteFailed = true;
  });

  afterAll(async () => {
    if (!fx) return;
    const force = process.env.MANTA_E2E_KEEP === '1';
    if (suiteFailed || force) {
      // eslint-disable-next-line no-console -- forensics signal for the human running the dogfood
      console.warn(
        `[forking-realities.e2e] preserving evidence at ${fx.root} (${
          force ? 'MANTA_E2E_KEEP=1' : 'test failed'
        }) — inspect docs/post-mortems, docs/merge-reviews, docs/zk, .manta/state, .manta/worktrees`,
      );
      return;
    }
    await fx.cleanup();
  });

  it('runs a 2-clone forking-realities cast with merge review and forensic timeline', async () => {
    if (!claude.available) {
      console.warn(`[forking-realities.e2e] SKIPPED: ${claude.reason}`);
      return;
    }
    fx = await makeSampleRepo();

    const tasksYaml = path.join(fx.root, 'tasks.yaml');
    await fs.writeFile(
      tasksYaml,
      [
        'A:',
        "  approach_hint: 'Extract as a pure function validateCredentials(user, pass) returning boolean'",
        'B:',
        "  approach_hint: 'Extract as a class CredentialValidator with a validate method'",
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
        cliBin, 'cast', 'forking-realities',
        '--clones', String(expectedCloneCount),
        '--task', 'Refactor src/auth.ts to extract the validation logic into a separate function.',
        '--tasks', tasksYaml,
        '--max-files-changed', '5',
        '--allowed-paths', 'src,docs',
        '--cycle-interval-ms', '5000',
        '--tick-budget-ms', String(tickBudgetMs),
        '--budget-per-clone-usd', '5',
      ],
      { cwd: fx.root, reject: false, timeout: 28 * 60 * 1000 },
    );

    const { busPaths, Registry, EventsLog, systemClock } = await import('@manta/bus');
    const paths = busPaths(fx.root);
    const watcherRegistry = new Registry(paths, systemClock);

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
          continue;
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
    for (const f of pmFiles) {
      const body = await fs.readFile(path.join(pmDir, f), 'utf8');
      expect(body).toContain('# Post-mortem — clone');
      expect(body).toContain('## Event timeline');
    }

    // ── ZK notes ────────────────────────────────────────────────────────
    const zkDir = path.join(fx.root, 'docs/zk');
    const zkFiles = (await fs.readdir(zkDir)).filter((f) => f.endsWith('.md'));
    expect(zkFiles.length).toBeGreaterThanOrEqual(2);

    // ── Snapshots ───────────────────────────────────────────────────────
    const snapDirs = (await fs.readdir(path.join(fx.root, '.manta/snapshots')))
      .filter((d) => d.startsWith('cast-'));
    expect(snapDirs.length).toBeGreaterThanOrEqual(1);
    const snaps = await fs.readdir(path.join(fx.root, '.manta/snapshots', snapDirs[0]!));
    expect(snaps).toContain('A.snapshot.json');
    expect(snaps).toContain('B.snapshot.json');

    // ── Worktrees retained ──────────────────────────────────────────────
    for (const id of ['A', 'B']) {
      const wt = path.join(fx.root, '.manta/worktrees', `clone-${id}`);
      await expect(fs.access(wt)).resolves.toBeUndefined();
    }

    // ── Each clone's worktree branch has at least 1 commit ──────────────
    expect(observedCastId).toBeDefined();
    for (const id of ['A', 'B']) {
      const branch = `manta/${observedCastId}/${id}`;
      const logResult = await execa(
        'git', ['log', '--oneline', `main..${branch}`],
        { cwd: fx.root, reject: false },
      );
      const commitCount = logResult.stdout.trim().split('\n').filter((l) => l.length > 0).length;
      expect(commitCount).toBeGreaterThanOrEqual(1);
    }

    // ── Merge-review event in events.jsonl ──────────────────────────────
    const eventsLog = new EventsLog(paths, systemClock);
    const allEvents = await eventsLog.readAll();
    const mergeReviewEvents = allEvents.filter(
      (e) =>
        e.type === 'merge_review' &&
        (e.payload as Record<string, unknown>)?.cast_id === observedCastId,
    );
    expect(mergeReviewEvents.length).toBeGreaterThanOrEqual(1);

    const payload = mergeReviewEvents[0]!.payload as Record<string, unknown>;
    expect(payload.verdict).toBeDefined();
    expect([
      'auto_merge_eligible',
      'manual_review_required',
      'no_candidates_passed_gate',
      'dominance_inversion_flagged',
    ]).toContain(payload.verdict);

    // ── Merge-review markdown at docs/merge-reviews/<castId>.md ─────────
    const mrDir = path.join(fx.root, 'docs/merge-reviews');
    const mrFile = path.join(mrDir, `${observedCastId}.md`);
    const mrStat = await fs.stat(mrFile);
    expect(mrStat.isFile()).toBe(true);
    const mrBody = await fs.readFile(mrFile, 'utf8');
    expect(mrBody.length).toBeGreaterThan(0);

    // ── Forensic timeline JSONL at .manta/state/timelines/<castId>.ndjson ──
    const ftPath = path.join(fx.root, '.manta/state/timelines', `${observedCastId}.ndjson`);
    const ftStat = await fs.stat(ftPath);
    expect(ftStat.isFile()).toBe(true);
    const ftBody = await fs.readFile(ftPath, 'utf8');
    const ftLines = ftBody.trim().split('\n').filter((l) => l.length > 0);
    expect(ftLines.length).toBeGreaterThanOrEqual(1);
    const firstEntry = JSON.parse(ftLines[0]!) as Record<string, unknown>;
    expect(firstEntry.cast_id).toBe(observedCastId);
  }, 28 * 60 * 1000);
});
