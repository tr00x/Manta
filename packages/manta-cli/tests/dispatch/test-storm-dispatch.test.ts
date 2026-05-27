import { describe, it, expect } from 'vitest';
import { TestStormDispatcher } from '../../src/dispatch/test-storm-dispatch.js';

describe('TestStormDispatcher', () => {
  const baseConfig = {
    coderCloneId: 'A',
    testerCloneId: 'B',
    fuzzerCloneId: 'C',
    castId: 'cast-1',
    maxFixCycles: 3,
  };

  it('initializes with empty stages', () => {
    const d = new TestStormDispatcher(baseConfig);
    expect(d.stages.size).toBe(0);
    expect(d.isDone).toBe(false);
  });

  it('creates stage on code_ready and routes to tester', async () => {
    const d = new TestStormDispatcher(baseConfig);
    const enqueued: Array<{ target: string; prompt: string }> = [];
    await d.onCycleComplete({
      idleClones: [{ clone_id: 'A', idle_since: 100 }],
      broadcasts: [{
        clone_id: 'A',
        event_type: 'code_ready',
        payload: { feature_id: 'feat-1', commit_ref: 'abc123', summary: 'add cache layer', files_changed: ['src/cache.ts'] },
      }],
    }, {
      enqueue: async (target, prompt) => { enqueued.push({ target, prompt }); },
    });
    expect(d.stages.get('feat-1')!.status).toBe('testing');
    expect(d.stages.get('feat-1')!.codeCommitRef).toBe('abc123');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.target).toBe('B');
    expect(enqueued[0]!.prompt).toContain('feat-1');
  });

  it('routes tests_ready (pass) to fuzzer', async () => {
    const d = new TestStormDispatcher(baseConfig);
    d.stages.set('feat-1', { featureId: 'feat-1', status: 'testing', fixCycles: 0, codeCommitRef: 'abc123' });
    const enqueued: Array<{ target: string; prompt: string }> = [];
    await d.onCycleComplete({
      idleClones: [{ clone_id: 'B', idle_since: 200 }],
      broadcasts: [{
        clone_id: 'B',
        event_type: 'tests_ready',
        payload: { feature_id: 'feat-1', verdict: 'pass', commit_ref: 'def456', summary: 'all tests pass' },
      }],
    }, {
      enqueue: async (target, prompt) => { enqueued.push({ target, prompt }); },
    });
    expect(d.stages.get('feat-1')!.status).toBe('fuzzing');
    expect(d.stages.get('feat-1')!.testCommitRef).toBe('def456');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.target).toBe('C');
    expect(enqueued[0]!.prompt).toContain('feat-1');
  });

  it('routes fuzz_complete to done', async () => {
    const d = new TestStormDispatcher(baseConfig);
    d.stages.set('feat-1', { featureId: 'feat-1', status: 'fuzzing', fixCycles: 0, codeCommitRef: 'abc', testCommitRef: 'def' });
    const enqueued: Array<{ target: string }> = [];
    await d.onCycleComplete({
      idleClones: [{ clone_id: 'C', idle_since: 300 }],
      broadcasts: [{
        clone_id: 'C',
        event_type: 'fuzz_complete',
        payload: { feature_id: 'feat-1', commit_ref: 'ghi789', summary: 'property tests pass' },
      }],
    }, {
      enqueue: async (target) => { enqueued.push({ target }); },
    });
    expect(d.stages.get('feat-1')!.status).toBe('complete');
    expect(d.stages.get('feat-1')!.fuzzCommitRef).toBe('ghi789');
    expect(enqueued).toHaveLength(0);
  });

  it('routes fix-request back to coder on test failure (blocker)', async () => {
    const d = new TestStormDispatcher(baseConfig);
    d.stages.set('feat-1', { featureId: 'feat-1', status: 'testing', fixCycles: 0, codeCommitRef: 'abc' });
    const enqueued: Array<{ target: string; prompt: string; priority?: string }> = [];
    await d.onCycleComplete({
      idleClones: [{ clone_id: 'B', idle_since: 200 }],
      broadcasts: [{
        clone_id: 'B',
        event_type: 'tests_ready',
        payload: {
          feature_id: 'feat-1', verdict: 'fail',
          failures: [{ test: 'test_x', error: 'null ref' }],
        },
      }],
    }, {
      enqueue: async (target, prompt, priority) => { enqueued.push({ target, prompt, priority }); },
    });
    expect(d.stages.get('feat-1')!.status).toBe('fixing');
    expect(d.stages.get('feat-1')!.fixCycles).toBe(1);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.target).toBe('A');
    expect(enqueued[0]!.priority).toBe('high');
  });

  it('routes fix completion back to testing', async () => {
    const d = new TestStormDispatcher(baseConfig);
    d.stages.set('feat-1', { featureId: 'feat-1', status: 'fixing', fixCycles: 1, codeCommitRef: 'abc' });
    const enqueued: Array<{ target: string }> = [];
    await d.onCycleComplete({
      idleClones: [{ clone_id: 'A', idle_since: 100 }],
      broadcasts: [{
        clone_id: 'A',
        event_type: 'code_ready',
        payload: { feature_id: 'feat-1', commit_ref: 'fix-abc', summary: 'fixed null ref' },
      }],
    }, {
      enqueue: async (target) => { enqueued.push({ target }); },
    });
    expect(d.stages.get('feat-1')!.status).toBe('testing');
    expect(d.stages.get('feat-1')!.codeCommitRef).toBe('fix-abc');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.target).toBe('B');
  });

  it('escalates after max fix cycles', async () => {
    const d = new TestStormDispatcher(baseConfig);
    d.stages.set('feat-1', { featureId: 'feat-1', status: 'testing', fixCycles: 3, codeCommitRef: 'abc' });
    const enqueued: Array<{ target: string }> = [];
    await d.onCycleComplete({
      idleClones: [{ clone_id: 'B', idle_since: 200 }],
      broadcasts: [{
        clone_id: 'B',
        event_type: 'tests_ready',
        payload: { feature_id: 'feat-1', verdict: 'fail', failures: [{ test: 'x', error: 'err' }] },
      }],
    }, {
      enqueue: async (target) => { enqueued.push({ target }); },
    });
    expect(d.stages.get('feat-1')!.status).toBe('escalated');
    expect(enqueued).toHaveLength(0);
  });

  it('isDone returns true when all stages complete', () => {
    const d = new TestStormDispatcher(baseConfig);
    d.stages.set('feat-1', { featureId: 'feat-1', status: 'complete', fixCycles: 0 });
    d.stages.set('feat-2', { featureId: 'feat-2', status: 'complete', fixCycles: 1 });
    expect(d.isDone).toBe(true);
  });

  it('isDone returns true when all stages escalated or complete', () => {
    const d = new TestStormDispatcher(baseConfig);
    d.stages.set('feat-1', { featureId: 'feat-1', status: 'complete', fixCycles: 0 });
    d.stages.set('feat-2', { featureId: 'feat-2', status: 'escalated', fixCycles: 3 });
    expect(d.isDone).toBe(true);
  });

  it('isDone returns false with empty stages', () => {
    const d = new TestStormDispatcher(baseConfig);
    expect(d.isDone).toBe(false);
  });

  it('isDone returns false with in-progress stages', () => {
    const d = new TestStormDispatcher(baseConfig);
    d.stages.set('feat-1', { featureId: 'feat-1', status: 'complete', fixCycles: 0 });
    d.stages.set('feat-2', { featureId: 'feat-2', status: 'testing', fixCycles: 0 });
    expect(d.isDone).toBe(false);
  });

  it('no-ops when all stages done', async () => {
    const d = new TestStormDispatcher(baseConfig);
    d.stages.set('feat-1', { featureId: 'feat-1', status: 'complete', fixCycles: 0 });
    const enqueued: string[] = [];
    await d.onCycleComplete({
      idleClones: [],
      broadcasts: [{ clone_id: 'A', event_type: 'code_ready', payload: { feature_id: 'feat-1' } }],
    }, { enqueue: async (t) => { enqueued.push(t); } });
    expect(enqueued).toHaveLength(0);
  });

  it('ignores broadcasts from wrong clone', async () => {
    const d = new TestStormDispatcher(baseConfig);
    const enqueued: string[] = [];
    await d.onCycleComplete({
      idleClones: [],
      broadcasts: [{ clone_id: 'D', event_type: 'code_ready', payload: { feature_id: 'feat-1', commit_ref: 'x', summary: 'y' } }],
    }, { enqueue: async (t) => { enqueued.push(t); } });
    expect(d.stages.size).toBe(0);
    expect(enqueued).toHaveLength(0);
  });

  it('handles multiple features concurrently', async () => {
    const d = new TestStormDispatcher(baseConfig);
    const enqueued: Array<{ target: string; prompt: string }> = [];
    const enqueuer = { enqueue: async (target: string, prompt: string) => { enqueued.push({ target, prompt }); } };

    await d.onCycleComplete({
      idleClones: [],
      broadcasts: [
        { clone_id: 'A', event_type: 'code_ready', payload: { feature_id: 'feat-1', commit_ref: 'a1', summary: 'f1' } },
        { clone_id: 'A', event_type: 'code_ready', payload: { feature_id: 'feat-2', commit_ref: 'a2', summary: 'f2' } },
      ],
    }, enqueuer);
    expect(d.stages.size).toBe(2);
    expect(d.stages.get('feat-1')!.status).toBe('testing');
    expect(d.stages.get('feat-2')!.status).toBe('testing');
    expect(enqueued).toHaveLength(2);
  });
});
