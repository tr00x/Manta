import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const ScoringWeightsSchema = z.object({
  coverage: z.number().min(0).max(1),
  diff: z.number().min(0).max(1),
  complexity: z.number().min(0).max(1),
  typeCheck: z.number().min(0).max(1),
  lint: z.number().min(0).max(1),
});

export const ScoringConfigSchema = z.object({
  weights: ScoringWeightsSchema,
  perfBonus: z.number().min(0).max(0.5),
  epsilon: z.number().min(0).max(0.5),
});

export type ScoringConfig = z.infer<typeof ScoringConfigSchema>;
export type ScoringWeights = z.infer<typeof ScoringWeightsSchema>;

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  weights: { coverage: 0.30, diff: 0.20, complexity: 0.20, typeCheck: 0.15, lint: 0.15 },
  perfBonus: 0.10,
  epsilon: 0.05,
};

export async function loadScoringConfig(repoRoot: string): Promise<ScoringConfig> {
  const configPath = join(repoRoot, '.manta', 'config', 'scoring.json');
  try {
    const raw = await readFile(configPath, 'utf-8');
    return ScoringConfigSchema.parse(JSON.parse(raw));
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return DEFAULT_SCORING_CONFIG;
    }
    throw err;
  }
}

export interface RawCandidateMetrics {
  cloneId: string;
  testsPassed: boolean;
  coverageDelta: number;
  diffLinesChanged: number;
  complexityDelta: number;
  tscErrors: number;
  eslintWarnings: number;
  eslintErrors: number;
  perfDeltaMs: number | null;
  selfCertainty: number | null;
}

export interface MetricCollector {
  collect(cloneId: string, worktreePath: string, baseBranch: string): Promise<Omit<RawCandidateMetrics, 'selfCertainty'>>;
}

export interface NormalizedCandidate {
  cloneId: string;
  disqualified: false;
  normalized: {
    coverage: number;
    diff: number;
    complexity: number;
    typeCheck: number;
    lint: number;
    perf: number | null;
  };
  raw: RawCandidateMetrics;
}

export interface DisqualifiedCandidate {
  cloneId: string;
  disqualified: true;
  reason: 'test_gate';
  raw: RawCandidateMetrics;
}

function normalizeHigherBetter(values: number[]): number[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 1.0);
  return values.map((v) => (v - min) / (max - min));
}

function normalizeLowerBetterLog(values: number[]): number[] {
  const logs = values.map((v) => Math.log10(1 + v));
  const min = Math.min(...logs);
  const max = Math.max(...logs);
  if (max === min) return values.map(() => 1.0);
  return logs.map((l) => 1 - (l - min) / (max - min));
}

export function normalizeCohort(candidates: RawCandidateMetrics[]): (NormalizedCandidate | DisqualifiedCandidate)[] {
  const disqualified: DisqualifiedCandidate[] = candidates
    .filter((c) => !c.testsPassed)
    .map((c) => ({ cloneId: c.cloneId, disqualified: true as const, reason: 'test_gate' as const, raw: c }));

  const surviving = candidates.filter((c) => c.testsPassed);
  if (surviving.length === 0) return disqualified;

  const coverageNorm = normalizeHigherBetter(surviving.map((c) => c.coverageDelta));
  const diffNorm = normalizeLowerBetterLog(surviving.map((c) => c.diffLinesChanged));
  const complexityNorm = normalizeLowerBetterLog(surviving.map((c) => c.complexityDelta));

  const hasPerfData = surviving.some((c) => c.perfDeltaMs !== null);
  let perfNorm: (number | null)[] = surviving.map(() => null);
  if (hasPerfData) {
    const perfValues = surviving.map((c) => c.perfDeltaMs);
    const nonNullPerfs = perfValues.filter((v): v is number => v !== null);
    if (nonNullPerfs.length > 0) {
      const logs = perfValues.map((v) => (v !== null ? Math.log10(1 + v) : null));
      const nonNullLogs = logs.filter((l): l is number => l !== null);
      const min = Math.min(...nonNullLogs);
      const max = Math.max(...nonNullLogs);
      perfNorm = logs.map((l) => {
        if (l === null) return null;
        if (max === min) return 1.0;
        return 1 - (l - min) / (max - min);
      });
    }
  }

  const normalized: NormalizedCandidate[] = surviving.map((c, i) => ({
    cloneId: c.cloneId,
    disqualified: false as const,
    normalized: {
      coverage: coverageNorm[i]!,
      diff: diffNorm[i]!,
      complexity: complexityNorm[i]!,
      typeCheck: 1 / (1 + c.tscErrors),
      lint: 1 / (1 + c.eslintWarnings + 5 * c.eslintErrors),
      perf: perfNorm[i] ?? null,
    },
    raw: c,
  }));

  return [...disqualified, ...normalized];
}

export function computeCompositeScore(candidate: NormalizedCandidate, config: ScoringConfig): number {
  const { weights: w } = config;
  const n = candidate.normalized;
  let score = w.coverage * n.coverage + w.diff * n.diff + w.complexity * n.complexity + w.typeCheck * n.typeCheck + w.lint * n.lint;
  if (n.perf !== null) {
    score += config.perfBonus * n.perf;
  }
  return score;
}

export interface RankedCandidate extends NormalizedCandidate {
  score: number;
  rank: number;
}

export function rankCandidates(candidates: NormalizedCandidate[], config: ScoringConfig): RankedCandidate[] {
  const scored = candidates.map((c) => ({ ...c, score: computeCompositeScore(c, config), rank: 0 }));
  scored.sort((a, b) => b.score - a.score);
  scored.forEach((c, i) => { c.rank = i + 1; });
  return scored;
}

export interface TieBreakResult {
  winner: RankedCandidate;
  method: 'axis_priority' | 'pareto' | 'self_certainty' | 'defer';
}

const AXIS_PRIORITY: (keyof NormalizedCandidate['normalized'])[] = ['coverage', 'complexity', 'diff', 'lint', 'typeCheck', 'perf'];

function isTied(candidates: RankedCandidate[], config: ScoringConfig): RankedCandidate[] {
  if (candidates.length < 2) return candidates;
  const scores = candidates.map((c) => c.score);
  const scoreRange = Math.max(...scores) - Math.min(...scores);
  if (scoreRange === 0) return candidates;
  const topScore = candidates[0]!.score;
  return candidates.filter((c) => (topScore - c.score) / scoreRange < config.epsilon);
}

export function breakTies(tied: RankedCandidate[], config: ScoringConfig): TieBreakResult {
  const contenders = isTied(tied, config);
  if (contenders.length <= 1) {
    return { winner: (contenders[0] ?? tied[0])!, method: 'defer' };
  }

  for (const axis of AXIS_PRIORITY) {
    const values = contenders.map((c) => c.normalized[axis]);
    if (values.some((v) => v === null)) continue;
    const max = Math.max(...(values as number[]));
    const leaders = contenders.filter((c) => c.normalized[axis] === max);
    if (leaders.length === 1) {
      return { winner: leaders[0]!, method: 'axis_priority' };
    }
  }

  for (let i = 0; i < contenders.length; i++) {
    const candidate = contenders[i]!;
    let dominatesAll = true;
    for (let j = 0; j < contenders.length; j++) {
      if (i === j) continue;
      if (!paretoDominates(candidate, contenders[j]!)) {
        dominatesAll = false;
        break;
      }
    }
    if (dominatesAll) {
      return { winner: candidate, method: 'pareto' };
    }
  }

  const top = contenders[0]!;
  const second = contenders[1]!;
  if (top.raw.selfCertainty !== null && second.raw.selfCertainty !== null) {
    const diff = top.raw.selfCertainty - second.raw.selfCertainty;
    if (Math.abs(diff) >= 0.5) {
      const winner = diff >= 0 ? top : second;
      return { winner, method: 'self_certainty' };
    }
  }

  return { winner: tied[0]!, method: 'defer' };
}

function paretoDominates(a: NormalizedCandidate, b: NormalizedCandidate): boolean {
  let strictlyBetter = false;
  for (const axis of AXIS_PRIORITY) {
    const va = a.normalized[axis];
    const vb = b.normalized[axis];
    if (va === null || vb === null) continue;
    if (va < vb) return false;
    if (va > vb) strictlyBetter = true;
  }
  return strictlyBetter;
}

export interface DominationAnomaly {
  dominatorCloneId: string;
  dominatedCloneId: string;
  axes: string[];
}

export function assertNoDominationInversion(ranked: RankedCandidate[]): DominationAnomaly[] {
  if (ranked.length < 2) return [];
  const top = ranked[0]!;
  const anomalies: DominationAnomaly[] = [];

  for (let i = 1; i < ranked.length; i++) {
    const lower = ranked[i]!;
    if (paretoDominates(lower, top)) {
      const axes: string[] = [];
      for (const axis of AXIS_PRIORITY) {
        const vLower = lower.normalized[axis];
        const vTop = top.normalized[axis];
        if (vLower === null || vTop === null) continue;
        if (vLower > vTop) axes.push(axis);
      }
      anomalies.push({ dominatorCloneId: lower.cloneId, dominatedCloneId: top.cloneId, axes });
    }
  }

  return anomalies;
}
