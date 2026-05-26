import { describe, it, expect, afterEach } from 'vitest';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';
import { createRuntime } from '../../src/runtime.js';
import {
  runMergeReview,
  findFinalisedCasts,
  inMemoryMergeReviewWriter,
  type BusContext as MergeReviewBusContext,
  type RawCandidateMetrics,
} from '@manta/orchestrator';
import { adjustWeightsFromProject } from '../../src/commands/rubric-prepass.js';
import { DEFAULT_SCORING_CONFIG } from '@manta/orchestrator';

describe('merge-review integration', () => {
  let fx: RepoFixture | undefined;
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  it('full merge-review pipeline: 3 candidates, 1 disqualified, winner identified', async () => {
    fx = await makeRepoFixture('manta-mr-int-');
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: {
        heartbeatTimeoutMs: 100,
        startupGraceMs: 100,
        parentPidCheckEnabled: false,
      },
    });

    const castId = 'cast-mr-test-1';

    await rt.ctx.casts.create({
      cast_id: castId,
      mode: 'forking-realities',
      clones: [
        { clone_id: 'A', assignment: null },
        { clone_id: 'B', assignment: null },
        { clone_id: 'C', assignment: null },
      ],
      policy: { peer_messaging: 'denied', auto_merge_threshold: null },
    });

    for (const id of ['A', 'B', 'C']) {
      await rt.ctx.registry.register({
        clone_id: id,
        mode: 'forking-realities',
        parent_pid: process.pid,
        worktree: `/tmp/fake-wt-${id}`,
        metadata: { cast_id: castId },
      });
      await rt.ctx.registry.markDead(id, `completed`);
    }

    const mrCtx = rt.ctx as unknown as MergeReviewBusContext;

    const finalisedBefore = await findFinalisedCasts(mrCtx, { mode: 'forking-realities' });
    expect(finalisedBefore).toHaveLength(1);
    expect(finalisedBefore[0]!.manifest.cast_id).toBe(castId);

    const candidates: RawCandidateMetrics[] = [
      {
        cloneId: 'A',
        testsPassed: true,
        coverageDelta: 5,
        diffLinesChanged: 50,
        complexityDelta: 2,
        tscErrors: 0,
        eslintWarnings: 3,
        eslintErrors: 0,
        perfDeltaMs: null,
        selfCertainty: 8,
      },
      {
        cloneId: 'B',
        testsPassed: true,
        coverageDelta: 3,
        diffLinesChanged: 30,
        complexityDelta: 1,
        tscErrors: 0,
        eslintWarnings: 0,
        eslintErrors: 0,
        perfDeltaMs: null,
        selfCertainty: 7,
      },
      {
        cloneId: 'C',
        testsPassed: false,
        coverageDelta: 0,
        diffLinesChanged: 100,
        complexityDelta: 10,
        tscErrors: 5,
        eslintWarnings: 10,
        eslintErrors: 2,
        perfDeltaMs: null,
        selfCertainty: null,
      },
    ];

    const writer = inMemoryMergeReviewWriter();
    const { result } = await runMergeReview(mrCtx, {
      castId,
      candidates,
      config: DEFAULT_SCORING_CONFIG,
      writer,
    });

    expect(result.disqualified).toHaveLength(1);
    expect(result.disqualified[0]!.cloneId).toBe('C');
    expect(result.disqualified[0]!.reason).toBe('test_gate');

    expect(result.ranked).toHaveLength(2);
    expect(result.ranked[0]!.score).toBeGreaterThan(0);
    expect(result.ranked[1]!.score).toBeGreaterThan(0);

    expect(result.verdict).toBe('manual_review_required');

    expect(writer.captured).toHaveLength(1);
    expect(writer.captured[0]!.filename).toBe(`${castId}.md`);
    expect(writer.captured[0]!.body).toContain('Merge Review');

    const finalisedAfter = await findFinalisedCasts(mrCtx, { mode: 'forking-realities' });
    expect(finalisedAfter).toHaveLength(0);
  });

  it('rubric pre-pass adjusts weights for strict tsconfig projects', async () => {
    fx = await makeRepoFixture('manta-mr-rubric-');

    await fx.run(['config', 'user.email', 'test@example.com']);
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await writeFile(
      join(fx.root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { strict: true, noUncheckedIndexedAccess: true },
      }),
      'utf-8',
    );

    const { config, adjustments } = await adjustWeightsFromProject(fx.root, DEFAULT_SCORING_CONFIG);
    expect(adjustments.length).toBeGreaterThan(0);
    expect(config.weights.typeCheck).toBeGreaterThan(DEFAULT_SCORING_CONFIG.weights.typeCheck);

    const weightSum = Object.values(config.weights).reduce((a, b) => a + b, 0);
    expect(weightSum).toBeCloseTo(1.0, 5);
  });

  it('no candidates pass gate → no_candidates_passed_gate verdict', async () => {
    fx = await makeRepoFixture('manta-mr-nopass-');
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: {
        heartbeatTimeoutMs: 100,
        startupGraceMs: 100,
        parentPidCheckEnabled: false,
      },
    });

    const castId = 'cast-mr-nopass';
    await rt.ctx.casts.create({
      cast_id: castId,
      mode: 'forking-realities',
      clones: [{ clone_id: 'A', assignment: null }],
      policy: { peer_messaging: 'denied', auto_merge_threshold: null },
    });

    const candidates: RawCandidateMetrics[] = [
      {
        cloneId: 'A',
        testsPassed: false,
        coverageDelta: 0,
        diffLinesChanged: 0,
        complexityDelta: 0,
        tscErrors: 0,
        eslintWarnings: 0,
        eslintErrors: 0,
        perfDeltaMs: null,
        selfCertainty: null,
      },
    ];

    const writer = inMemoryMergeReviewWriter();
    const mrCtx = rt.ctx as unknown as MergeReviewBusContext;
    const { result } = await runMergeReview(mrCtx, {
      castId,
      candidates,
      config: DEFAULT_SCORING_CONFIG,
      writer,
    });

    expect(result.verdict).toBe('no_candidates_passed_gate');
    expect(result.ranked).toHaveLength(0);
    expect(result.disqualified).toHaveLength(1);
  });
});
