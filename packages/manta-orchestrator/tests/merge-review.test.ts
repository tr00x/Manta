import { describe, it, expect } from 'vitest';
import type { CastManifest } from '@manta/bus';
import type { CloneRecord } from '@manta/bus';
import type { RawCandidateMetrics } from '../src/scoring';
import { DEFAULT_SCORING_CONFIG } from '../src/scoring';
import { inMemoryMergeReviewWriter } from '../src/merge-review-writer';
import {
  findFinalisedCasts,
  runMergeReview,
  renderMergeReviewMarkdown,
} from '../src/merge-review';
import type { BusContext, MergeReviewResult } from '../src/merge-review';

function makeManifest(castId: string, cloneIds: string[], opts?: { mode?: string; autoMergeThreshold?: number | null }): CastManifest {
  return {
    version: 1,
    cast_id: castId,
    mode: (opts?.mode ?? 'forking-realities') as CastManifest['mode'],
    clones: cloneIds.map((id) => ({ clone_id: id, assignment: null })),
    policy: {
      peer_messaging: 'denied',
      auto_merge_threshold: opts?.autoMergeThreshold !== undefined ? opts.autoMergeThreshold : 0.6,
    },
    created_at: Date.now(),
  };
}

function makeClone(cloneId: string, state: CloneRecord['state']): CloneRecord {
  return {
    clone_id: cloneId,
    mode: 'forking-realities',
    parent_pid: 1234,
    worktree: `/tmp/wt-${cloneId}`,
    metadata: {},
    registered_at: Date.now() - 60_000,
    last_heartbeat_at: Date.now() - 5_000,
    state,
    ...(state === 'DEAD' ? { death_reason: 'completed', died_at: Date.now() - 1_000 } : {}),
  };
}

interface MockBusContext extends BusContext {
  _appendedEvents: unknown[];
}

function mockBusContext(
  manifests: CastManifest[],
  clones: CloneRecord[],
  events: Array<{ type: string; payload?: Record<string, unknown> }>,
): MockBusContext {
  const appendedEvents: unknown[] = [];
  return {
    casts: {
      list: () => Promise.resolve(manifests),
      read: (id) => {
        const found = manifests.find((m) => m.cast_id === id);
        if (!found) return Promise.reject(new Error(`manifest not found: ${id}`));
        return Promise.resolve(found);
      },
    },
    registry: { list: () => Promise.resolve(clones) },
    events: {
      readAll: () => Promise.resolve(events),
      append: (r) => { appendedEvents.push(r); return Promise.resolve(); },
    },
    _appendedEvents: appendedEvents,
  };
}

describe('findFinalisedCasts', () => {
  it('finds cast with all clones DEAD and no prior merge_review event', async () => {
    const manifest = makeManifest('cast-1', ['clone-a', 'clone-b']);
    const clones = [makeClone('clone-a', 'DEAD'), makeClone('clone-b', 'DEAD')];
    const ctx = mockBusContext([manifest], clones, []);

    const result = await findFinalisedCasts(ctx);
    expect(result).toHaveLength(1);
    expect(result[0]!.manifest.cast_id).toBe('cast-1');
    expect(result[0]!.deadClones).toHaveLength(2);
  });

  it('excludes cast when one clone is still WORKING', async () => {
    const manifest = makeManifest('cast-2', ['clone-a', 'clone-b']);
    const clones = [makeClone('clone-a', 'DEAD'), makeClone('clone-b', 'WORKING')];
    const ctx = mockBusContext([manifest], clones, []);

    const result = await findFinalisedCasts(ctx);
    expect(result).toHaveLength(0);
  });

  it('excludes cast that already has a merge_review event', async () => {
    const manifest = makeManifest('cast-3', ['clone-a']);
    const clones = [makeClone('clone-a', 'DEAD')];
    const events = [{ type: 'merge_review', payload: { cast_id: 'cast-3' } }];
    const ctx = mockBusContext([manifest], clones, events);

    const result = await findFinalisedCasts(ctx);
    expect(result).toHaveLength(0);
  });

  it('filters by mode when specified', async () => {
    const manifest1 = makeManifest('cast-4', ['clone-a'], { mode: 'forking-realities' });
    const manifest2 = makeManifest('cast-5', ['clone-b'], { mode: 'recon-swarm' });
    const clones = [makeClone('clone-a', 'DEAD'), makeClone('clone-b', 'DEAD')];
    const ctx = mockBusContext([manifest1, manifest2], clones, []);

    const result = await findFinalisedCasts(ctx, { mode: 'recon-swarm' });
    expect(result).toHaveLength(1);
    expect(result[0]!.manifest.cast_id).toBe('cast-5');
  });

  it('excludes cast when clone is missing from registry', async () => {
    const manifest = makeManifest('cast-6', ['clone-a', 'clone-missing']);
    const clones = [makeClone('clone-a', 'DEAD')];
    const ctx = mockBusContext([manifest], clones, []);

    const result = await findFinalisedCasts(ctx);
    expect(result).toHaveLength(0);
  });
});

describe('runMergeReview', () => {
  function makeCandidate(cloneId: string, overrides?: Partial<RawCandidateMetrics>): RawCandidateMetrics {
    return {
      cloneId,
      testsPassed: true,
      coverageDelta: 5,
      diffLinesChanged: 100,
      complexityDelta: 2,
      tscErrors: 0,
      eslintWarnings: 0,
      eslintErrors: 0,
      perfDeltaMs: null,
      selfCertainty: null,
      ...overrides,
    };
  }

  it('produces no_candidates_passed_gate when all fail tests', async () => {
    const manifest = makeManifest('cast-gate', ['c1', 'c2']);
    const ctx = mockBusContext([manifest], [], []);
    const writer = inMemoryMergeReviewWriter();

    const { result } = await runMergeReview(ctx, {
      castId: 'cast-gate',
      candidates: [
        makeCandidate('c1', { testsPassed: false }),
        makeCandidate('c2', { testsPassed: false }),
      ],
      config: DEFAULT_SCORING_CONFIG,
      writer,
    });

    expect(result.verdict).toBe('no_candidates_passed_gate');
    expect(result.ranked).toHaveLength(0);
    expect(result.disqualified).toHaveLength(2);
    expect(writer.captured).toHaveLength(1);
    expect(ctx._appendedEvents).toHaveLength(1);
  });

  it('full flow: 3 candidates, 1 disqualified, winner identified', async () => {
    const manifest = makeManifest('cast-full', ['c1', 'c2', 'c3'], { autoMergeThreshold: 0.3 });
    const ctx = mockBusContext([manifest], [], []);
    const writer = inMemoryMergeReviewWriter();

    const candidates: RawCandidateMetrics[] = [
      makeCandidate('c1', { testsPassed: false }),
      makeCandidate('c2', { coverageDelta: 10, diffLinesChanged: 50, complexityDelta: 1 }),
      makeCandidate('c3', { coverageDelta: 3, diffLinesChanged: 200, complexityDelta: 5 }),
    ];

    const { result, written } = await runMergeReview(ctx, {
      castId: 'cast-full',
      candidates,
      config: DEFAULT_SCORING_CONFIG,
      writer,
    });

    expect(result.verdict).toBe('auto_merge_eligible');
    expect(result.disqualified).toHaveLength(1);
    expect(result.disqualified[0]!.cloneId).toBe('c1');
    expect(result.ranked).toHaveLength(2);
    expect(result.ranked[0]!.cloneId).toBe('c2');
    expect(result.ranked[0]!.rank).toBe(1);
    expect(written.path).toContain('cast-full.md');

    const event = ctx._appendedEvents[0] as { type: string; payload: Record<string, unknown> };
    expect(event.type).toBe('merge_review');
    expect(event.payload.cast_id).toBe('cast-full');
    expect(event.payload.verdict).toBe('auto_merge_eligible');
    expect(event.payload.winner_clone_id).toBe('c2');
  });

  it('returns manual_review_required when auto_merge_threshold is null', async () => {
    const manifest = makeManifest('cast-null-thresh', ['c1', 'c2'], { autoMergeThreshold: null });
    const ctx = mockBusContext([manifest], [], []);
    const writer = inMemoryMergeReviewWriter();

    const { result } = await runMergeReview(ctx, {
      castId: 'cast-null-thresh',
      candidates: [
        makeCandidate('c1', { coverageDelta: 10 }),
        makeCandidate('c2', { coverageDelta: 3 }),
      ],
      config: DEFAULT_SCORING_CONFIG,
      writer,
    });

    expect(result.verdict).toBe('manual_review_required');
  });

  it('emits event with correct payload structure', async () => {
    const manifest = makeManifest('cast-event', ['c1'], { autoMergeThreshold: 0.1 });
    const ctx = mockBusContext([manifest], [], []);
    const writer = inMemoryMergeReviewWriter();

    await runMergeReview(ctx, {
      castId: 'cast-event',
      candidates: [makeCandidate('c1')],
      config: DEFAULT_SCORING_CONFIG,
      writer,
    });

    const event = ctx._appendedEvents[0] as { type: string; payload: Record<string, unknown> };
    expect(event.type).toBe('merge_review');
    expect(event.payload).toHaveProperty('cast_id', 'cast-event');
    expect(event.payload).toHaveProperty('verdict');
    expect(event.payload).toHaveProperty('winner_clone_id');
    expect(event.payload).toHaveProperty('scores');
    expect(event.payload).toHaveProperty('tie_break_method');
  });
});

describe('renderMergeReviewMarkdown', () => {
  it('renders all expected sections', () => {
    const review: MergeReviewResult = {
      castId: 'cast-render',
      verdict: 'auto_merge_eligible',
      ranked: [
        {
          cloneId: 'winner',
          disqualified: false,
          normalized: { coverage: 0.9, diff: 0.8, complexity: 0.7, typeCheck: 1.0, lint: 1.0, perf: null },
          raw: { cloneId: 'winner', testsPassed: true, coverageDelta: 10, diffLinesChanged: 50, complexityDelta: 1, tscErrors: 0, eslintWarnings: 0, eslintErrors: 0, perfDeltaMs: null, selfCertainty: null },
          score: 0.87,
          rank: 1,
        },
      ],
      disqualified: [
        { cloneId: 'loser', disqualified: true, reason: 'test_gate', raw: { cloneId: 'loser', testsPassed: false, coverageDelta: 0, diffLinesChanged: 0, complexityDelta: 0, tscErrors: 5, eslintWarnings: 10, eslintErrors: 2, perfDeltaMs: null, selfCertainty: null } },
      ],
      tieBreak: null,
      anomalies: [],
      weightAdjustments: [{ axis: 'coverage', oldWeight: 0.3, newWeight: 0.4, reason: 'user override' }],
      config: DEFAULT_SCORING_CONFIG,
    };

    const md = renderMergeReviewMarkdown(review);

    expect(md).toContain('# Merge Review — cast-render');
    expect(md).toContain('**Verdict:** auto_merge_eligible');
    expect(md).toContain('| Rank | Clone |');
    expect(md).toContain('| 1 | winner |');
    expect(md).toContain('## Disqualified');
    expect(md).toContain('**loser**: test_gate');
    expect(md).toContain('## Weight Adjustments');
    expect(md).toContain('**coverage**: 0.3');
    expect(md).toContain('git merge manta/cast-render/winner --no-ff');
  });

  it('renders tie-break section when present', () => {
    const review: MergeReviewResult = {
      castId: 'cast-tie',
      verdict: 'auto_merge_eligible',
      ranked: [
        {
          cloneId: 'tied-winner',
          disqualified: false,
          normalized: { coverage: 0.9, diff: 0.9, complexity: 0.9, typeCheck: 1.0, lint: 1.0, perf: null },
          raw: { cloneId: 'tied-winner', testsPassed: true, coverageDelta: 10, diffLinesChanged: 50, complexityDelta: 1, tscErrors: 0, eslintWarnings: 0, eslintErrors: 0, perfDeltaMs: null, selfCertainty: null },
          score: 0.92,
          rank: 1,
        },
      ],
      disqualified: [],
      tieBreak: {
        winner: {
          cloneId: 'tied-winner',
          disqualified: false,
          normalized: { coverage: 0.9, diff: 0.9, complexity: 0.9, typeCheck: 1.0, lint: 1.0, perf: null },
          raw: { cloneId: 'tied-winner', testsPassed: true, coverageDelta: 10, diffLinesChanged: 50, complexityDelta: 1, tscErrors: 0, eslintWarnings: 0, eslintErrors: 0, perfDeltaMs: null, selfCertainty: null },
          score: 0.92,
          rank: 1,
        },
        method: 'axis_priority',
      },
      anomalies: [],
      weightAdjustments: [],
      config: DEFAULT_SCORING_CONFIG,
    };

    const md = renderMergeReviewMarkdown(review);
    expect(md).toContain('## Tie-Break');
    expect(md).toContain('**Method:** axis_priority');
    expect(md).toContain('**Winner:** tied-winner');
  });

  it('renders dominance anomalies section', () => {
    const review: MergeReviewResult = {
      castId: 'cast-anomaly',
      verdict: 'dominance_inversion_flagged',
      ranked: [
        {
          cloneId: 'top',
          disqualified: false,
          normalized: { coverage: 0.5, diff: 0.5, complexity: 0.5, typeCheck: 1.0, lint: 1.0, perf: null },
          raw: { cloneId: 'top', testsPassed: true, coverageDelta: 5, diffLinesChanged: 100, complexityDelta: 3, tscErrors: 0, eslintWarnings: 0, eslintErrors: 0, perfDeltaMs: null, selfCertainty: null },
          score: 0.65,
          rank: 1,
        },
      ],
      disqualified: [],
      tieBreak: null,
      anomalies: [{ dominatorCloneId: 'bottom', dominatedCloneId: 'top', axes: ['coverage', 'diff'] }],
      weightAdjustments: [],
      config: DEFAULT_SCORING_CONFIG,
    };

    const md = renderMergeReviewMarkdown(review);
    expect(md).toContain('## Dominance Anomalies');
    expect(md).toContain('bottom dominates top on axes: coverage, diff');
  });

  it('omits merge command when no ranked candidates', () => {
    const review: MergeReviewResult = {
      castId: 'cast-empty',
      verdict: 'no_candidates_passed_gate',
      ranked: [],
      disqualified: [],
      tieBreak: null,
      anomalies: [],
      weightAdjustments: [],
      config: DEFAULT_SCORING_CONFIG,
    };

    const md = renderMergeReviewMarkdown(review);
    expect(md).not.toContain('git merge');
    expect(md).not.toContain('## Proposed Merge');
  });
});
