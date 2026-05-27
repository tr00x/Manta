import type { DispatchCycleInput, DispatchEnqueuer } from './types.js';

export interface TestStormConfig {
  coderCloneId: string;
  testerCloneId: string;
  fuzzerCloneId: string;
  castId: string;
  maxFixCycles: number;
}

export interface TestStormStage {
  featureId: string;
  codeCommitRef?: string;
  testCommitRef?: string;
  fuzzCommitRef?: string;
  fixCycles: number;
  status: 'coding' | 'testing' | 'fuzzing' | 'fixing' | 'complete' | 'escalated';
}

export class TestStormDispatcher {
  stages = new Map<string, TestStormStage>();

  constructor(private readonly config: TestStormConfig) {}

  async onCycleComplete(input: DispatchCycleInput, enqueuer: DispatchEnqueuer): Promise<void> {
    for (const b of input.broadcasts) {
      const featureId = String((b.payload as Record<string, unknown>).feature_id ?? '');
      if (!featureId) continue;

      switch (b.event_type) {
        case 'code_ready':
          await this.handleCodeReady(b, featureId, enqueuer);
          break;
        case 'tests_ready':
          await this.handleTestsReady(b, featureId, enqueuer);
          break;
        case 'fuzz_complete':
          await this.handleFuzzComplete(b, featureId);
          break;
        case 'blocker':
          await this.handleBlocker(b, featureId, enqueuer);
          break;
      }
    }
  }

  get isDone(): boolean {
    if (this.stages.size === 0) return false;
    return [...this.stages.values()].every(
      (s) => s.status === 'complete' || s.status === 'escalated',
    );
  }

  private async handleCodeReady(
    broadcast: DispatchCycleInput['broadcasts'][number],
    featureId: string,
    enqueuer: DispatchEnqueuer,
  ): Promise<void> {
    const p = broadcast.payload;
    const commitRef = String(p.commit_ref ?? '');
    const filesChanged = (p.files_changed as string[]) ?? [];

    const existing = this.stages.get(featureId);

    if (existing && existing.status === 'fixing') {
      existing.status = 'testing';
      existing.codeCommitRef = commitRef;
      await enqueuer.enqueue(
        this.config.testerCloneId,
        buildTestPrompt({ featureId, commitRef, filesChanged, fixCycle: existing.fixCycles }),
      );
      return;
    }

    if (!existing) {
      this.stages.set(featureId, {
        featureId,
        status: 'testing',
        fixCycles: 0,
        codeCommitRef: commitRef,
      });
      await enqueuer.enqueue(
        this.config.testerCloneId,
        buildTestPrompt({ featureId, commitRef, filesChanged, fixCycle: 0 }),
      );
    }
  }

  private async handleTestsReady(
    broadcast: DispatchCycleInput['broadcasts'][number],
    featureId: string,
    enqueuer: DispatchEnqueuer,
  ): Promise<void> {
    const stage = this.stages.get(featureId);
    if (!stage || stage.status !== 'testing') return;

    const p = broadcast.payload;
    const pass = Boolean(p.pass);
    const commitRef = String(p.commit_ref ?? '');

    if (pass) {
      stage.status = 'fuzzing';
      stage.testCommitRef = commitRef;
      await enqueuer.enqueue(
        this.config.fuzzerCloneId,
        buildFuzzPrompt({ featureId, codeRef: stage.codeCommitRef ?? '', testRef: commitRef }),
      );
      return;
    }

    if (stage.fixCycles >= this.config.maxFixCycles) {
      stage.status = 'escalated';
      return;
    }

    stage.status = 'fixing';
    stage.fixCycles += 1;
    const failures = (p.failures as Array<Record<string, unknown>>) ?? [];
    await enqueuer.enqueue(
      this.config.coderCloneId,
      buildFixPrompt({ featureId, failures, fixCycle: stage.fixCycles }),
      'high',
    );
  }

  private async handleFuzzComplete(
    broadcast: DispatchCycleInput['broadcasts'][number],
    featureId: string,
  ): Promise<void> {
    const stage = this.stages.get(featureId);
    if (!stage || stage.status !== 'fuzzing') return;

    const p = broadcast.payload;
    stage.fuzzCommitRef = String(p.commit_ref ?? '');
    stage.status = 'complete';
  }

  private async handleBlocker(
    broadcast: DispatchCycleInput['broadcasts'][number],
    featureId: string,
    enqueuer: DispatchEnqueuer,
  ): Promise<void> {
    const stage = this.stages.get(featureId);
    if (!stage || (stage.status !== 'testing' && stage.status !== 'fuzzing')) return;

    if (stage.fixCycles >= this.config.maxFixCycles) {
      stage.status = 'escalated';
      return;
    }

    stage.status = 'fixing';
    stage.fixCycles += 1;
    const failures = ((broadcast.payload as Record<string, unknown>).failures as Array<Record<string, unknown>>) ?? [];
    await enqueuer.enqueue(
      this.config.coderCloneId,
      buildFixPrompt({ featureId, failures, fixCycle: stage.fixCycles }),
      'high',
    );
  }
}

function buildTestPrompt(ctx: {
  featureId: string; commitRef: string; filesChanged: string[]; fixCycle: number;
}): string {
  const lines = [
    `Test feature "${ctx.featureId}" (commit: ${ctx.commitRef}).`,
  ];
  if (ctx.fixCycle > 0) {
    lines.push(`This is fix cycle ${ctx.fixCycle} — re-run previously failing tests first.`);
  }
  if (ctx.filesChanged.length > 0) {
    lines.push(`Files changed: ${ctx.filesChanged.join(', ')}`);
  }
  lines.push(
    '',
    'Run existing tests. Write new tests for uncovered paths.',
    'Broadcast tests_ready with { feature_id, pass: true/false, commit_ref, failures? }.',
  );
  return lines.join('\n');
}

function buildFuzzPrompt(ctx: {
  featureId: string; codeRef: string; testRef: string;
}): string {
  return [
    `Fuzz feature "${ctx.featureId}".`,
    `Code commit: ${ctx.codeRef}, test commit: ${ctx.testRef}.`,
    '',
    'Write property-based tests and boundary-condition tests.',
    'Focus on edge cases the standard test suite may miss.',
    'Broadcast fuzz_complete with { feature_id, commit_ref, issues_found }.',
  ].join('\n');
}

function buildFixPrompt(ctx: {
  featureId: string;
  failures: Array<Record<string, unknown>>;
  fixCycle: number;
}): string {
  const lines = [
    `Fix failures in feature "${ctx.featureId}" (fix cycle ${ctx.fixCycle}).`,
    '',
    'Failures:',
  ];
  for (const f of ctx.failures) {
    lines.push(`- ${f.test ?? 'unknown'}: ${f.error ?? 'no details'}`);
  }
  lines.push(
    '',
    'Fix the root cause, re-run tests locally, then broadcast code_ready.',
  );
  return lines.join('\n');
}
