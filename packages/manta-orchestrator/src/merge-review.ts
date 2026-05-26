import type { CastManifest } from '@manta/bus';
import type { CloneRecord } from '@manta/bus';
import type {
  RawCandidateMetrics,
  ScoringConfig,
  RankedCandidate,
  DisqualifiedCandidate,
  NormalizedCandidate,
  TieBreakResult,
  DominationAnomaly,
} from './scoring';
import { normalizeCohort, rankCandidates, assertNoDominationInversion, breakTies } from './scoring';
import type { MergeReviewWriter } from './merge-review-writer';

export interface FinalisedCast {
  manifest: CastManifest;
  deadClones: CloneRecord[];
}

export interface WeightAdjustment {
  axis: string;
  oldWeight: number;
  newWeight: number;
  reason: string;
}

export type MergeReviewVerdict =
  | 'auto_merge_eligible'
  | 'manual_review_required'
  | 'no_candidates_passed_gate'
  | 'dominance_inversion_flagged';

export interface MergeReviewResult {
  castId: string;
  verdict: MergeReviewVerdict;
  ranked: RankedCandidate[];
  disqualified: DisqualifiedCandidate[];
  tieBreak: TieBreakResult | null;
  anomalies: DominationAnomaly[];
  weightAdjustments: WeightAdjustment[];
  config: ScoringConfig;
}

export interface RunMergeReviewOptions {
  castId: string;
  candidates: RawCandidateMetrics[];
  config: ScoringConfig;
  weightAdjustments?: WeightAdjustment[];
  writer: MergeReviewWriter;
}

export interface BusContext {
  casts: { read(castId: string): Promise<CastManifest>; list(): Promise<CastManifest[]> };
  registry: { list(): Promise<CloneRecord[]> };
  events: {
    readAll(): Promise<Array<{ type: string; clone_id?: string; payload: unknown }>>;
    append(record: unknown): Promise<void>;
  };
}

export interface FindFinalisedCastsOptions {
  mode?: string;
}

export async function findFinalisedCasts(
  ctx: BusContext,
  opts?: FindFinalisedCastsOptions,
): Promise<FinalisedCast[]> {
  const [manifests, allClones, events] = await Promise.all([
    ctx.casts.list(),
    ctx.registry.list(),
    ctx.events.readAll(),
  ]);

  const reviewedCastIds = new Set(
    events
      .filter((e) => e.type === 'merge_review' && (e.payload as Record<string, unknown>)?.cast_id)
      .map((e) => (e.payload as Record<string, unknown>).cast_id as string),
  );

  const results: FinalisedCast[] = [];

  for (const manifest of manifests) {
    if (opts?.mode && manifest.mode !== opts.mode) continue;
    if (reviewedCastIds.has(manifest.cast_id)) continue;

    const rosterIds = manifest.clones.map((c) => c.clone_id);
    const matched = allClones.filter((r) => rosterIds.includes(r.clone_id));

    if (matched.length !== rosterIds.length) continue;
    if (!matched.every((r) => r.state === 'DEAD')) continue;

    results.push({ manifest, deadClones: matched });
  }

  return results;
}

export async function runMergeReview(
  ctx: BusContext,
  opts: RunMergeReviewOptions,
): Promise<{ result: MergeReviewResult; written: { path: string } }> {
  const cohort = normalizeCohort(opts.candidates);
  const disqualified = cohort.filter((c): c is DisqualifiedCandidate => c.disqualified);
  const normalized = cohort.filter((c): c is NormalizedCandidate => !c.disqualified);

  if (normalized.length === 0) {
    const result: MergeReviewResult = {
      castId: opts.castId,
      verdict: 'no_candidates_passed_gate',
      ranked: [],
      disqualified,
      tieBreak: null,
      anomalies: [],
      weightAdjustments: opts.weightAdjustments ?? [],
      config: opts.config,
    };
    const markdown = renderMergeReviewMarkdown(result);
    const written = await opts.writer.write({ filename: `${opts.castId}.md`, body: markdown });
    await ctx.events.append({
      type: 'merge_review',
      payload: {
        cast_id: opts.castId,
        verdict: result.verdict,
        winner_clone_id: null,
        scores: [],
        tie_break_method: null,
      },
    });
    return { result, written };
  }

  const ranked = rankCandidates(normalized, opts.config);
  const anomalies = assertNoDominationInversion(ranked);

  let tieBreak: TieBreakResult | null = null;
  let verdict: MergeReviewVerdict;

  const topCandidate = ranked[0]!;

  if (anomalies.length > 0) {
    verdict = 'dominance_inversion_flagged';
  } else {
    const tiedCandidates = ranked.filter(
      (c) => topCandidate.score - c.score <= opts.config.epsilon * topCandidate.score,
    );
    if (tiedCandidates.length > 1) {
      tieBreak = breakTies(tiedCandidates, opts.config);
      if (tieBreak.method === 'defer') {
        verdict = 'manual_review_required';
      } else {
        verdict = await determineAutoMergeVerdict(ctx, opts, topCandidate.score, tieBreak.winner.score);
      }
    } else {
      verdict = await determineAutoMergeVerdict(ctx, opts, topCandidate.score, topCandidate.score);
    }
  }

  const result: MergeReviewResult = {
    castId: opts.castId,
    verdict,
    ranked,
    disqualified,
    tieBreak,
    anomalies,
    weightAdjustments: opts.weightAdjustments ?? [],
    config: opts.config,
  };

  const markdown = renderMergeReviewMarkdown(result);
  const written = await opts.writer.write({ filename: `${opts.castId}.md`, body: markdown });

  await ctx.events.append({
    type: 'merge_review',
    payload: {
      cast_id: opts.castId,
      verdict: result.verdict,
      winner_clone_id: ranked[0]?.cloneId ?? null,
      scores: ranked.map((r) => ({ clone_id: r.cloneId, score: r.score })),
      tie_break_method: tieBreak?.method ?? null,
    },
  });

  return { result, written };
}

async function determineAutoMergeVerdict(
  ctx: BusContext,
  opts: RunMergeReviewOptions,
  _topScore: number,
  winnerScore: number,
): Promise<MergeReviewVerdict> {
  const manifest = await ctx.casts.read(opts.castId);
  const threshold = manifest.policy.auto_merge_threshold;
  if (threshold === null) return 'manual_review_required';
  return winnerScore >= threshold ? 'auto_merge_eligible' : 'manual_review_required';
}

export function renderMergeReviewMarkdown(review: MergeReviewResult): string {
  const lines: string[] = [];

  lines.push(`# Merge Review — ${review.castId}`);
  lines.push('');
  lines.push(`**Verdict:** ${review.verdict}`);
  lines.push('');

  if (review.ranked.length > 0) {
    lines.push('## Scores');
    lines.push('');
    lines.push('| Rank | Clone | Coverage | Diff | Complexity | TypeCheck | Lint | Perf | Composite |');
    lines.push('|------|-------|----------|------|------------|-----------|------|------|-----------|');
    for (const r of review.ranked) {
      const n = r.normalized;
      const perf = n.perf !== null ? n.perf.toFixed(3) : 'N/A';
      lines.push(
        `| ${r.rank} | ${r.cloneId} | ${n.coverage.toFixed(3)} | ${n.diff.toFixed(3)} | ${n.complexity.toFixed(3)} | ${n.typeCheck.toFixed(3)} | ${n.lint.toFixed(3)} | ${perf} | ${r.score.toFixed(4)} |`,
      );
    }
    lines.push('');
  }

  if (review.disqualified.length > 0) {
    lines.push('## Disqualified');
    lines.push('');
    for (const d of review.disqualified) {
      lines.push(`- **${d.cloneId}**: ${d.reason}`);
    }
    lines.push('');
  }

  if (review.tieBreak) {
    lines.push('## Tie-Break');
    lines.push('');
    lines.push(`- **Method:** ${review.tieBreak.method}`);
    lines.push(`- **Winner:** ${review.tieBreak.winner.cloneId}`);
    lines.push('');
  }

  if (review.anomalies.length > 0) {
    lines.push('## Dominance Anomalies');
    lines.push('');
    for (const a of review.anomalies) {
      lines.push(`- ${a.dominatorCloneId} dominates ${a.dominatedCloneId} on axes: ${a.axes.join(', ')}`);
    }
    lines.push('');
  }

  if (review.weightAdjustments.length > 0) {
    lines.push('## Weight Adjustments');
    lines.push('');
    for (const wa of review.weightAdjustments) {
      lines.push(`- **${wa.axis}**: ${wa.oldWeight} → ${wa.newWeight} (${wa.reason})`);
    }
    lines.push('');
  }

  if (review.ranked.length > 0) {
    const winner = review.tieBreak?.winner.cloneId ?? review.ranked[0]!.cloneId;
    lines.push('## Proposed Merge');
    lines.push('');
    lines.push(`\`\`\`bash`);
    lines.push(`git merge manta/${review.castId}/${winner} --no-ff`);
    lines.push(`\`\`\``);
    lines.push('');
  }

  return lines.join('\n');
}
