import { describe, it, expect } from 'vitest';
import {
  ScoringConfigSchema,
  DEFAULT_SCORING_CONFIG,
  loadScoringConfig,
  normalizeCohort,
  computeCompositeScore,
  rankCandidates,
  breakTies,
  assertNoDominationInversion,
} from '../src/scoring';
import type {
  RawCandidateMetrics,
  NormalizedCandidate,
  RankedCandidate,
  DisqualifiedCandidate,
} from '../src/scoring';

function makeMetrics(overrides: Partial<RawCandidateMetrics> & { cloneId: string }): RawCandidateMetrics {
  return {
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

describe('ScoringConfigSchema', () => {
  it('validates a correct config', () => {
    const result = ScoringConfigSchema.safeParse(DEFAULT_SCORING_CONFIG);
    expect(result.success).toBe(true);
  });

  it('rejects weights above 1', () => {
    const bad = { ...DEFAULT_SCORING_CONFIG, weights: { ...DEFAULT_SCORING_CONFIG.weights, coverage: 1.5 } };
    const result = ScoringConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects negative perfBonus', () => {
    const bad = { ...DEFAULT_SCORING_CONFIG, perfBonus: -0.1 };
    const result = ScoringConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects epsilon above 0.5', () => {
    const bad = { ...DEFAULT_SCORING_CONFIG, epsilon: 0.6 };
    const result = ScoringConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });
});

describe('DEFAULT_SCORING_CONFIG', () => {
  it('weights sum to 1.0', () => {
    const w = DEFAULT_SCORING_CONFIG.weights;
    const sum = w.coverage + w.diff + w.complexity + w.typeCheck + w.lint;
    expect(sum).toBeCloseTo(1.0, 10);
  });
});

describe('loadScoringConfig', () => {
  it('falls back to defaults on missing file', async () => {
    const config = await loadScoringConfig('/nonexistent/path');
    expect(config).toEqual(DEFAULT_SCORING_CONFIG);
  });
});

describe('normalizeCohort', () => {
  it('disqualifies candidates with failed tests', () => {
    const candidates = [makeMetrics({ cloneId: 'a', testsPassed: false })];
    const result = normalizeCohort(candidates);
    expect(result).toHaveLength(1);
    expect(result[0]!.disqualified).toBe(true);
    expect((result[0]! as DisqualifiedCandidate).reason).toBe('test_gate');
  });

  it('returns only disqualified entries when all fail', () => {
    const candidates = [
      makeMetrics({ cloneId: 'a', testsPassed: false }),
      makeMetrics({ cloneId: 'b', testsPassed: false }),
    ];
    const result = normalizeCohort(candidates);
    expect(result.every((r) => r.disqualified)).toBe(true);
  });

  it('normalizes 3 varied candidates correctly', () => {
    const candidates = [
      makeMetrics({ cloneId: 'a', coverageDelta: 10, diffLinesChanged: 50, complexityDelta: 1 }),
      makeMetrics({ cloneId: 'b', coverageDelta: 5, diffLinesChanged: 100, complexityDelta: 3 }),
      makeMetrics({ cloneId: 'c', coverageDelta: 0, diffLinesChanged: 200, complexityDelta: 5 }),
    ];
    const result = normalizeCohort(candidates);
    const normalized = result.filter((r): r is NormalizedCandidate => !r.disqualified);
    expect(normalized).toHaveLength(3);
    const a = normalized.find((n) => n.cloneId === 'a')!;
    const c = normalized.find((n) => n.cloneId === 'c')!;
    expect(a.normalized.coverage).toBe(1.0);
    expect(c.normalized.coverage).toBe(0.0);
    expect(a.normalized.diff).toBe(1.0);
    expect(c.normalized.diff).toBe(0.0);
  });

  it('single candidate gets 1.0 everywhere', () => {
    const candidates = [makeMetrics({ cloneId: 'solo', coverageDelta: 7, diffLinesChanged: 42, complexityDelta: 3 })];
    const result = normalizeCohort(candidates);
    const n = result.find((r): r is NormalizedCandidate => !r.disqualified)!;
    expect(n.normalized.coverage).toBe(1.0);
    expect(n.normalized.diff).toBe(1.0);
    expect(n.normalized.complexity).toBe(1.0);
  });

  it('coverage tie normalizes to 1.0 for all', () => {
    const candidates = [
      makeMetrics({ cloneId: 'a', coverageDelta: 5 }),
      makeMetrics({ cloneId: 'b', coverageDelta: 5 }),
    ];
    const result = normalizeCohort(candidates);
    const normalized = result.filter((r): r is NormalizedCandidate => !r.disqualified);
    expect(normalized[0]!.normalized.coverage).toBe(1.0);
    expect(normalized[1]!.normalized.coverage).toBe(1.0);
  });
});

describe('computeCompositeScore', () => {
  it('computes expected score for known inputs', () => {
    const candidate: NormalizedCandidate = {
      cloneId: 'x',
      disqualified: false,
      normalized: { coverage: 1.0, diff: 0.5, complexity: 0.8, typeCheck: 1.0, lint: 1.0, perf: null },
      raw: makeMetrics({ cloneId: 'x' }),
    };
    const score = computeCompositeScore(candidate, DEFAULT_SCORING_CONFIG);
    const expected = 0.30 * 1.0 + 0.20 * 0.5 + 0.20 * 0.8 + 0.15 * 1.0 + 0.15 * 1.0;
    expect(score).toBeCloseTo(expected, 10);
  });

  it('applies perf bonus only when non-null', () => {
    const withPerf: NormalizedCandidate = {
      cloneId: 'p',
      disqualified: false,
      normalized: { coverage: 1.0, diff: 1.0, complexity: 1.0, typeCheck: 1.0, lint: 1.0, perf: 1.0 },
      raw: makeMetrics({ cloneId: 'p' }),
    };
    const withoutPerf: NormalizedCandidate = { ...withPerf, normalized: { ...withPerf.normalized, perf: null } };
    const scoreWith = computeCompositeScore(withPerf, DEFAULT_SCORING_CONFIG);
    const scoreWithout = computeCompositeScore(withoutPerf, DEFAULT_SCORING_CONFIG);
    expect(scoreWith - scoreWithout).toBeCloseTo(0.10, 10);
  });
});

describe('rankCandidates', () => {
  it('ranks in descending score order', () => {
    const a: NormalizedCandidate = {
      cloneId: 'a', disqualified: false,
      normalized: { coverage: 0.5, diff: 0.5, complexity: 0.5, typeCheck: 0.5, lint: 0.5, perf: null },
      raw: makeMetrics({ cloneId: 'a' }),
    };
    const b: NormalizedCandidate = {
      cloneId: 'b', disqualified: false,
      normalized: { coverage: 1.0, diff: 1.0, complexity: 1.0, typeCheck: 1.0, lint: 1.0, perf: null },
      raw: makeMetrics({ cloneId: 'b' }),
    };
    const ranked = rankCandidates([a, b], DEFAULT_SCORING_CONFIG);
    expect(ranked[0]!.cloneId).toBe('b');
    expect(ranked[0]!.rank).toBe(1);
    expect(ranked[1]!.cloneId).toBe('a');
    expect(ranked[1]!.rank).toBe(2);
  });
});

describe('breakTies', () => {
  function makeRanked(cloneId: string, norm: NormalizedCandidate['normalized'], score: number): RankedCandidate {
    return {
      cloneId, disqualified: false, normalized: norm, score, rank: 1,
      raw: makeMetrics({ cloneId }),
    };
  }

  it('resolves by axis priority', () => {
    const a = makeRanked('a', { coverage: 0.9, diff: 0.5, complexity: 0.5, typeCheck: 0.5, lint: 0.5, perf: null }, 0.6);
    const b = makeRanked('b', { coverage: 0.8, diff: 0.5, complexity: 0.5, typeCheck: 0.5, lint: 0.5, perf: null }, 0.6);
    const result = breakTies([a, b], DEFAULT_SCORING_CONFIG);
    expect(result.winner.cloneId).toBe('a');
    expect(result.method).toBe('axis_priority');
  });

  it('resolves by pareto dominance when axis priority cannot pick a single leader', () => {
    // 3 candidates: on every axis, multiple candidates share the max → axis_priority finds no single leader.
    // But 'a' Pareto-dominates 'c' (>=all, strictly> on some), and 'a' also dominates 'b' overall.
    const a = makeRanked('a', { coverage: 0.9, diff: 0.9, complexity: 0.9, typeCheck: 0.9, lint: 0.9, perf: null }, 0.8);
    const b = makeRanked('b', { coverage: 0.9, diff: 0.9, complexity: 0.9, typeCheck: 0.9, lint: 0.8, perf: null }, 0.8);
    const c = makeRanked('c', { coverage: 0.9, diff: 0.8, complexity: 0.9, typeCheck: 0.9, lint: 0.9, perf: null }, 0.8);
    // coverage: a,b,c all 0.9 → tied, no single leader
    // complexity: a,b,c all 0.9 → tied
    // diff: a,b both 0.9 → 2 leaders, not single
    // lint: a,c both 0.9 → 2 leaders, not single
    // typeCheck: a,b,c → a,b,c have 0.9, 0.9, 0.9 → tied
    // Wait, b has lint 0.8 and c has diff 0.8 — let me check axis_priority...
    // coverage: max=0.9, leaders=[a,b,c] → skip (not single)
    // complexity: max=0.9, leaders=[a,b,c] → skip
    // diff: max=0.9, leaders=[a,b] → skip (2 leaders)
    // lint: max=0.9, leaders=[a,c] → skip (2 leaders)
    // typeCheck: max=0.9, leaders=[a,b,c] → skip
    // perf: null → skip
    // → axis_priority exhausted, falls to pareto.
    // a dominates b? a.lint=0.9 > b.lint=0.8, all others >=. Yes.
    // a dominates c? a.diff=0.9 > c.diff=0.8, all others >=. Yes.
    // a dominates all → winner.
    const result = breakTies([a, b, c], { ...DEFAULT_SCORING_CONFIG, epsilon: 1.0 });
    expect(result.winner.cloneId).toBe('a');
    expect(result.method).toBe('pareto');
  });

  it('resolves by self-certainty', () => {
    const norm = { coverage: 0.8, diff: 0.8, complexity: 0.8, typeCheck: 0.8, lint: 0.8, perf: null };
    const a: RankedCandidate = {
      cloneId: 'a', disqualified: false, normalized: norm, score: 0.8, rank: 1,
      raw: makeMetrics({ cloneId: 'a', selfCertainty: 0.9 }),
    };
    const b: RankedCandidate = {
      cloneId: 'b', disqualified: false, normalized: norm, score: 0.8, rank: 2,
      raw: makeMetrics({ cloneId: 'b', selfCertainty: 0.3 }),
    };
    const result = breakTies([a, b], { ...DEFAULT_SCORING_CONFIG, epsilon: 1.0 });
    expect(result.winner.cloneId).toBe('a');
    expect(result.method).toBe('self_certainty');
  });

  it('defers when nothing resolves', () => {
    const norm = { coverage: 0.8, diff: 0.8, complexity: 0.8, typeCheck: 0.8, lint: 0.8, perf: null };
    const a = makeRanked('a', norm, 0.8);
    const b = makeRanked('b', norm, 0.8);
    const result = breakTies([a, b], { ...DEFAULT_SCORING_CONFIG, epsilon: 1.0 });
    expect(result.method).toBe('defer');
  });
});

describe('assertNoDominationInversion', () => {
  it('returns empty when top dominates', () => {
    const top: RankedCandidate = {
      cloneId: 'top', disqualified: false, score: 0.9, rank: 1,
      normalized: { coverage: 1.0, diff: 1.0, complexity: 1.0, typeCheck: 1.0, lint: 1.0, perf: null },
      raw: makeMetrics({ cloneId: 'top' }),
    };
    const lower: RankedCandidate = {
      cloneId: 'lower', disqualified: false, score: 0.5, rank: 2,
      normalized: { coverage: 0.5, diff: 0.5, complexity: 0.5, typeCheck: 0.5, lint: 0.5, perf: null },
      raw: makeMetrics({ cloneId: 'lower' }),
    };
    expect(assertNoDominationInversion([top, lower])).toEqual([]);
  });

  it('detects anomaly when dominated candidate ranks first', () => {
    const top: RankedCandidate = {
      cloneId: 'weak', disqualified: false, score: 0.9, rank: 1,
      normalized: { coverage: 0.3, diff: 0.3, complexity: 0.3, typeCheck: 0.3, lint: 0.3, perf: null },
      raw: makeMetrics({ cloneId: 'weak' }),
    };
    const lower: RankedCandidate = {
      cloneId: 'strong', disqualified: false, score: 0.8, rank: 2,
      normalized: { coverage: 0.9, diff: 0.9, complexity: 0.9, typeCheck: 0.9, lint: 0.9, perf: null },
      raw: makeMetrics({ cloneId: 'strong' }),
    };
    const anomalies = assertNoDominationInversion([top, lower]);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]!.dominatorCloneId).toBe('strong');
    expect(anomalies[0]!.dominatedCloneId).toBe('weak');
    expect(anomalies[0]!.axes).toContain('coverage');
  });
});
