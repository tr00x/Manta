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
      if (b.event_type === 'code_ready' && b.clone_id === this.config.coderCloneId) {
        await this.handleCodeReady(b.payload, enqueuer);
      } else if (b.event_type === 'tests_ready' && b.clone_id === this.config.testerCloneId) {
        await this.handleTestsReady(b.payload, enqueuer);
      } else if (b.event_type === 'fuzz_complete' && b.clone_id === this.config.fuzzerCloneId) {
        this.handleFuzzComplete(b.payload);
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
    payload: Record<string, unknown>,
    enqueuer: DispatchEnqueuer,
  ): Promise<void> {
    const featureId = String(payload.feature_id ?? 'default');
    const commitRef = String(payload.commit_ref ?? '');
    const summary = String(payload.summary ?? '');
    const existing = this.stages.get(featureId);

    if (!existing) {
      // First sighting of this feature — create a fresh stage and dispatch
      // the initial test run.
      this.stages.set(featureId, {
        featureId,
        codeCommitRef: commitRef,
        fixCycles: 0,
        status: 'testing',
      });
      await enqueuer.enqueue(
        this.config.testerCloneId,
        buildTestPrompt({ featureId, commitRef, summary, fixCycle: 0 }),
      );
      return;
    }

    // Bug #26: every reachable status needs an explicit branch. Before the
    // fix, `testing` / `fuzzing` fell through to a fresh-stage create which
    // silently reset fixCycles and wiped any in-flight refs. The `never`
    // arm at the end now forces future status additions to either handle
    // their own case or fail at compile time.
    const status: TestStormStage['status'] = existing.status;
    switch (status) {
      case 'complete':
      case 'escalated':
        // Terminal — ignore late duplicates entirely.
        return;
      case 'fixing': {
        // Coder shipped a fix; promote to testing and dispatch the tester.
        existing.codeCommitRef = commitRef;
        existing.status = 'testing';
        await enqueuer.enqueue(
          this.config.testerCloneId,
          buildTestPrompt({ featureId, commitRef, summary, fixCycle: existing.fixCycles }),
        );
        return;
      }
      case 'coding':
      case 'testing':
      case 'fuzzing': {
        // In-flight stage: a duplicate `code_ready` (coder retry, daemon
        // redelivery, race with broadcast settling). Only refresh the
        // codeCommitRef; do not reset fixCycles, status, or any refs we've
        // already collected. No new enqueue — the relevant worker is
        // already running.
        existing.codeCommitRef = commitRef;
        return;
      }
      default: {
        // Exhaustiveness guard: if a new status is added to the union, TS
        // will fail to compile this assignment, forcing the author to
        // handle it explicitly above.
        const _exhaustive: never = status;
        throw new Error(`unreachable test-storm status: ${String(_exhaustive)}`);
      }
    }
  }

  private async handleTestsReady(
    payload: Record<string, unknown>,
    enqueuer: DispatchEnqueuer,
  ): Promise<void> {
    const featureId = String(payload.feature_id ?? 'default');
    const verdict = String(payload.verdict ?? 'fail');
    const commitRef = String(payload.commit_ref ?? '');
    const stage = this.stages.get(featureId);
    if (!stage || stage.status !== 'testing') return;

    if (verdict === 'pass') {
      stage.testCommitRef = commitRef;
      stage.status = 'fuzzing';
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

    stage.fixCycles += 1;
    stage.status = 'fixing';
    const failures = (payload.failures as Array<Record<string, unknown>>) ?? [];
    await enqueuer.enqueue(
      this.config.coderCloneId,
      buildFixPrompt({
        featureId,
        failures,
        fixCycle: stage.fixCycles,
        maxFixCycles: this.config.maxFixCycles,
      }),
      'high',
    );
  }

  private handleFuzzComplete(payload: Record<string, unknown>): void {
    const featureId = String(payload.feature_id ?? 'default');
    const commitRef = String(payload.commit_ref ?? '');
    const stage = this.stages.get(featureId);
    if (!stage || stage.status !== 'fuzzing') return;
    stage.fuzzCommitRef = commitRef;
    stage.status = 'complete';
  }
}

function buildTestPrompt(ctx: {
  featureId: string; commitRef: string; summary: string; fixCycle: number;
}): string {
  const lines = [
    `Test feature "${ctx.featureId}" (fix cycle ${ctx.fixCycle}).`,
    `Code commit: ${ctx.commitRef}`,
    ctx.summary ? `Summary: ${ctx.summary}` : '',
    '',
    'Run the existing test suite against the code changes.',
    'Write new tests for uncovered code paths.',
    'Broadcast tests_ready with verdict: "pass" or "fail".',
    'Include failures array if any tests fail.',
  ].filter(Boolean);
  return lines.join('\n');
}

function buildFuzzPrompt(ctx: {
  featureId: string; codeRef: string; testRef: string;
}): string {
  return [
    `Fuzz-test feature "${ctx.featureId}".`,
    `Code commit: ${ctx.codeRef}`,
    `Test commit: ${ctx.testRef}`,
    '',
    'Write property-based and boundary tests.',
    'Focus on edge cases, invariants, and error paths.',
    'Broadcast fuzz_complete when done.',
  ].join('\n');
}

function buildFixPrompt(ctx: {
  featureId: string; failures: Array<Record<string, unknown>>; fixCycle: number; maxFixCycles: number;
}): string {
  const lines = [
    `Fix failures for feature "${ctx.featureId}" (fix cycle ${ctx.fixCycle}/${ctx.maxFixCycles}).`,
    '',
    'Failures:',
  ];
  for (const f of ctx.failures) {
    lines.push(`- ${String(f.test ?? '?')}: ${String(f.error ?? 'unknown error')}`);
  }
  lines.push('', 'Fix the root cause, re-run tests locally, then broadcast code_ready.');
  return lines.join('\n');
}
