import { describe, it, expect } from 'vitest';
import { TestStormDispatcher } from '../../src/dispatch/test-storm-dispatch';

function makeConfig(overrides: Partial<ConstructorParameters<typeof TestStormDispatcher>[0]> = {}) {
  return {
    coderCloneId: 'A',
    testerCloneId: 'B',
    fuzzerCloneId: 'C',
    castId: 'cast-1',
    maxFixCycles: 3,
    ...overrides,
  };
}

function makeEnqueuer() {
  const calls: Array<{ target: string; prompt: string; priority?: string }> = [];
  return {
    calls,
    enqueuer: {
      enqueue: async (target: string, prompt: string, priority?: 'normal' | 'high') => {
        calls.push({ target, prompt, priority });
      },
    },
  };
}

describe('TestStormDispatcher', () => {
  it('initializes with no stages and isDone=false', () => {
    const d = new TestStormDispatcher(makeConfig());
    expect(d.stages.size).toBe(0);
    expect(d.isDone).toBe(false);
  });

  it('creates coding stage and enqueues test work on code_ready broadcast', async () => {
    const d = new TestStormDispatcher(makeConfig());
    const { calls, enqueuer } = makeEnqueuer();

    await d.onCycleComplete({
      idleClones: [{ clone_id: 'A', idle_since: 100 }],
      broadcasts: [{
        clone_id: 'A',
        event_type: 'code_ready',
        payload: { commit_ref: 'abc', feature_id: 'feat-1', files_changed: ['src/x.ts'] },
      }],
    }, enqueuer);

    expect(d.stages.get('feat-1')!.status).toBe('testing');
    expect(d.stages.get('feat-1')!.codeCommitRef).toBe('abc');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.target).toBe('B');
    expect(calls[0]!.prompt).toContain('feat-1');
    expect(calls[0]!.prompt).toContain('abc');
  });

  it('enqueues fuzz work for fuzzer when tester broadcasts tests_ready with pass', async () => {
    const d = new TestStormDispatcher(makeConfig());
    d.stages.set('feat-1', {
      featureId: 'feat-1',
      status: 'testing',
      fixCycles: 0,
      codeCommitRef: 'abc',
    });
    const { calls, enqueuer } = makeEnqueuer();

    await d.onCycleComplete({
      idleClones: [{ clone_id: 'B', idle_since: 200 }],
      broadcasts: [{
        clone_id: 'B',
        event_type: 'tests_ready',
        payload: { feature_id: 'feat-1', pass: true, commit_ref: 'def' },
      }],
    }, enqueuer);

    expect(d.stages.get('feat-1')!.status).toBe('fuzzing');
    expect(d.stages.get('feat-1')!.testCommitRef).toBe('def');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.target).toBe('C');
  });

  it('routes fix-request back to coder on test failure (blocker)', async () => {
    const d = new TestStormDispatcher(makeConfig());
    d.stages.set('feat-1', {
      featureId: 'feat-1',
      status: 'testing',
      fixCycles: 0,
      codeCommitRef: 'abc',
    });
    const { calls, enqueuer } = makeEnqueuer();

    await d.onCycleComplete({
      idleClones: [{ clone_id: 'B', idle_since: 200 }],
      broadcasts: [{
        clone_id: 'B',
        event_type: 'tests_ready',
        payload: {
          feature_id: 'feat-1',
          pass: false,
          failures: [{ test: 'test_x', error: 'null ref' }],
        },
      }],
    }, enqueuer);

    expect(d.stages.get('feat-1')!.status).toBe('fixing');
    expect(d.stages.get('feat-1')!.fixCycles).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.target).toBe('A');
    expect(calls[0]!.priority).toBe('high');
    expect(calls[0]!.prompt).toContain('null ref');
  });

  it('transitions from fixing back to testing on new code_ready', async () => {
    const d = new TestStormDispatcher(makeConfig());
    d.stages.set('feat-1', {
      featureId: 'feat-1',
      status: 'fixing',
      fixCycles: 1,
      codeCommitRef: 'abc',
    });
    const { calls, enqueuer } = makeEnqueuer();

    await d.onCycleComplete({
      idleClones: [{ clone_id: 'A', idle_since: 100 }],
      broadcasts: [{
        clone_id: 'A',
        event_type: 'code_ready',
        payload: { commit_ref: 'abc2', feature_id: 'feat-1', files_changed: ['src/x.ts'] },
      }],
    }, enqueuer);

    expect(d.stages.get('feat-1')!.status).toBe('testing');
    expect(d.stages.get('feat-1')!.codeCommitRef).toBe('abc2');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.target).toBe('B');
  });

  it('completes pipeline on fuzz_complete', async () => {
    const d = new TestStormDispatcher(makeConfig());
    d.stages.set('feat-1', {
      featureId: 'feat-1',
      status: 'fuzzing',
      fixCycles: 0,
      codeCommitRef: 'abc',
      testCommitRef: 'def',
    });
    const { enqueuer } = makeEnqueuer();

    await d.onCycleComplete({
      idleClones: [{ clone_id: 'C', idle_since: 300 }],
      broadcasts: [{
        clone_id: 'C',
        event_type: 'fuzz_complete',
        payload: { feature_id: 'feat-1', commit_ref: 'ghi', issues_found: 0 },
      }],
    }, enqueuer);

    expect(d.stages.get('feat-1')!.status).toBe('complete');
    expect(d.stages.get('feat-1')!.fuzzCommitRef).toBe('ghi');
  });

  it('escalates after max fix cycles', async () => {
    const d = new TestStormDispatcher(makeConfig());
    d.stages.set('feat-1', {
      featureId: 'feat-1',
      status: 'testing',
      fixCycles: 3,
      codeCommitRef: 'abc',
    });
    const { calls, enqueuer } = makeEnqueuer();

    await d.onCycleComplete({
      idleClones: [{ clone_id: 'B', idle_since: 200 }],
      broadcasts: [{
        clone_id: 'B',
        event_type: 'tests_ready',
        payload: { feature_id: 'feat-1', pass: false },
      }],
    }, enqueuer);

    expect(d.stages.get('feat-1')!.status).toBe('escalated');
    expect(calls).toHaveLength(0);
  });

  it('isDone returns true when all stages are complete or escalated', async () => {
    const d = new TestStormDispatcher(makeConfig());
    d.stages.set('feat-1', {
      featureId: 'feat-1',
      status: 'complete',
      fixCycles: 0,
      codeCommitRef: 'abc',
    });
    d.stages.set('feat-2', {
      featureId: 'feat-2',
      status: 'escalated',
      fixCycles: 3,
      codeCommitRef: 'def',
    });
    expect(d.isDone).toBe(true);
  });

  it('isDone returns false when any stage is still in progress', () => {
    const d = new TestStormDispatcher(makeConfig());
    d.stages.set('feat-1', {
      featureId: 'feat-1',
      status: 'complete',
      fixCycles: 0,
      codeCommitRef: 'abc',
    });
    d.stages.set('feat-2', {
      featureId: 'feat-2',
      status: 'testing',
      fixCycles: 0,
      codeCommitRef: 'def',
    });
    expect(d.isDone).toBe(false);
  });

  it('ignores broadcasts for unknown event types', async () => {
    const d = new TestStormDispatcher(makeConfig());
    const { calls, enqueuer } = makeEnqueuer();

    await d.onCycleComplete({
      idleClones: [],
      broadcasts: [{
        clone_id: 'A',
        event_type: 'unknown_event',
        payload: { feature_id: 'feat-1' },
      }],
    }, enqueuer);

    expect(d.stages.size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('handles blocker broadcast by routing fix back to coder', async () => {
    const d = new TestStormDispatcher(makeConfig());
    d.stages.set('feat-1', {
      featureId: 'feat-1',
      status: 'testing',
      fixCycles: 0,
      codeCommitRef: 'abc',
    });
    const { calls, enqueuer } = makeEnqueuer();

    await d.onCycleComplete({
      idleClones: [],
      broadcasts: [{
        clone_id: 'B',
        event_type: 'blocker',
        payload: {
          feature_id: 'feat-1',
          failures: [{ test: 'integration', error: 'timeout' }],
        },
      }],
    }, enqueuer);

    expect(d.stages.get('feat-1')!.status).toBe('fixing');
    expect(calls[0]!.target).toBe('A');
    expect(calls[0]!.priority).toBe('high');
  });
});
