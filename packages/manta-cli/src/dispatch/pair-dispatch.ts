import type { DispatchCycleInput, DispatchEnqueuer } from './types.js';

export interface PairDispatcherConfig {
  writerCloneId: string;
  reviewerCloneId: string;
  castId: string;
  maxIterations: number;
}

export interface PairState {
  phase: 'writer_working' | 'reviewer_working' | 'done' | 'escalated';
  iteration: number;
  lastBroadcastTs: number;
}

export class PairDispatcher {
  state: PairState;

  constructor(private readonly config: PairDispatcherConfig) {
    this.state = { phase: 'writer_working', iteration: 1, lastBroadcastTs: 0 };
  }

  async onCycleComplete(input: DispatchCycleInput, enqueuer: DispatchEnqueuer): Promise<void> {
    if (this.state.phase === 'done' || this.state.phase === 'escalated') return;

    const commitReady = input.broadcasts.find(
      (b) => b.event_type === 'commit_ready' && b.clone_id === this.config.writerCloneId,
    );
    const reviewComplete = input.broadcasts.find(
      (b) => b.event_type === 'review_complete' && b.clone_id === this.config.reviewerCloneId,
    );

    if (this.state.phase === 'writer_working' && commitReady) {
      const p = commitReady.payload;
      const prompt = buildReviewPrompt({
        commitRef: String(p.commit_ref ?? ''),
        summary: String(p.summary ?? ''),
        filesChanged: (p.files_changed as string[]) ?? [],
        iteration: this.state.iteration,
        castId: this.config.castId,
        writerCloneId: this.config.writerCloneId,
      });
      await enqueuer.enqueue(this.config.reviewerCloneId, prompt);
      this.state.phase = 'reviewer_working';
      return;
    }

    if (this.state.phase === 'reviewer_working' && reviewComplete) {
      const p = reviewComplete.payload;
      const verdict = String(p.verdict ?? '');

      if (verdict === 'approved') {
        this.state.phase = 'done';
        return;
      }

      if (this.state.iteration >= this.config.maxIterations) {
        this.state.phase = 'escalated';
        return;
      }

      const prompt = buildFixPrompt({
        comments: (p.comments as Array<Record<string, unknown>>) ?? [],
        verdict,
        iteration: this.state.iteration,
      });
      const priority = verdict === 'blocker' ? 'high' as const : 'normal' as const;
      await enqueuer.enqueue(this.config.writerCloneId, prompt, priority);
      this.state.iteration += 1;
      this.state.phase = 'writer_working';
      return;
    }
  }

  get isDone(): boolean {
    return this.state.phase === 'done' || this.state.phase === 'escalated';
  }
}

function buildReviewPrompt(ctx: {
  commitRef: string; summary: string; filesChanged: string[];
  iteration: number; castId: string; writerCloneId: string;
}): string {
  return [
    `Review iteration ${ctx.iteration} from the writer clone (${ctx.writerCloneId}).`,
    `Commit: ${ctx.commitRef}`,
    `Summary: ${ctx.summary}`,
    `Files changed: ${ctx.filesChanged.join(', ')}`,
    '',
    'To review, run:',
    `  git diff main..manta/${ctx.castId}/${ctx.writerCloneId}`,
    '',
    'Check: correctness, edge cases, test coverage, spec compliance.',
    'Run tests if needed. Then broadcast review_complete with your verdict.',
  ].join('\n');
}

function buildFixPrompt(ctx: {
  comments: Array<Record<string, unknown>>; verdict: string; iteration: number;
}): string {
  const lines = [
    `The reviewer returned verdict: ${ctx.verdict} (iteration ${ctx.iteration}).`,
    '',
    'Feedback:',
  ];
  for (const c of ctx.comments) {
    const sev = String(c.severity ?? 'info').toUpperCase();
    lines.push(`- [${sev}] ${String(c.file ?? '?')}:${String(c.line ?? '?')} — ${String(c.comment ?? '')}`);
  }
  lines.push('', 'Apply CORRECTION and BLOCKER fixes. Re-run tests, commit, broadcast commit_ready.');
  return lines.join('\n');
}
