import { describe, it, expect } from 'vitest';
import { PairDispatcher } from '../../src/dispatch/pair-dispatch.js';

describe('PairDispatcher', () => {
  const baseConfig = { writerCloneId: 'A', reviewerCloneId: 'B', castId: 'cast-1', maxIterations: 5 };

  it('initializes with writer_working phase', () => {
    const d = new PairDispatcher(baseConfig);
    expect(d.state.phase).toBe('writer_working');
    expect(d.state.iteration).toBe(1);
  });

  it('transitions to reviewer_working on commit_ready broadcast', async () => {
    const d = new PairDispatcher(baseConfig);
    const enqueued: Array<{ target: string; prompt: string }> = [];
    await d.onCycleComplete({
      idleClones: [{ clone_id: 'A', idle_since: 100 }],
      broadcasts: [{ clone_id: 'A', event_type: 'commit_ready', payload: { commit_ref: 'abc123', summary: 'impl cache', files_changed: ['src/cache.ts'] } }],
    }, {
      enqueue: async (target, prompt) => { enqueued.push({ target, prompt }); },
    });
    expect(d.state.phase).toBe('reviewer_working');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.target).toBe('B');
    expect(enqueued[0]!.prompt).toContain('abc123');
  });

  it('transitions to done on review_complete with approved verdict', async () => {
    const d = new PairDispatcher(baseConfig);
    d.state.phase = 'reviewer_working';
    await d.onCycleComplete({
      idleClones: [{ clone_id: 'B', idle_since: 200 }],
      broadcasts: [{ clone_id: 'B', event_type: 'review_complete', payload: { verdict: 'approved', iteration: 1 } }],
    }, { enqueue: async () => {} });
    expect(d.state.phase).toBe('done');
  });

  it('loops back to writer on changes_requested', async () => {
    const d = new PairDispatcher(baseConfig);
    d.state.phase = 'reviewer_working';
    d.state.iteration = 1;
    const enqueued: Array<{ target: string }> = [];
    await d.onCycleComplete({
      idleClones: [{ clone_id: 'B', idle_since: 200 }],
      broadcasts: [{ clone_id: 'B', event_type: 'review_complete', payload: {
        verdict: 'changes_requested', iteration: 1,
        comments: [{ file: 'src/cache.ts', line: 42, severity: 'correction', comment: 'null check' }],
      } }],
    }, { enqueue: async (target) => { enqueued.push({ target }); } });
    expect(d.state.phase).toBe('writer_working');
    expect(d.state.iteration).toBe(2);
    expect(enqueued[0]!.target).toBe('A');
  });

  it('escalates after max iterations', async () => {
    const d = new PairDispatcher(baseConfig);
    d.state.phase = 'reviewer_working';
    d.state.iteration = 5;
    await d.onCycleComplete({
      idleClones: [{ clone_id: 'B', idle_since: 200 }],
      broadcasts: [{ clone_id: 'B', event_type: 'review_complete', payload: { verdict: 'changes_requested', iteration: 5 } }],
    }, { enqueue: async () => {} });
    expect(d.state.phase).toBe('escalated');
  });

  it('isDone returns true for done and escalated', () => {
    const d = new PairDispatcher(baseConfig);
    expect(d.isDone).toBe(false);
    d.state.phase = 'done';
    expect(d.isDone).toBe(true);
    d.state.phase = 'escalated';
    expect(d.isDone).toBe(true);
  });

  it('no-ops when already done', async () => {
    const d = new PairDispatcher(baseConfig);
    d.state.phase = 'done';
    const enqueued: string[] = [];
    await d.onCycleComplete({
      idleClones: [],
      broadcasts: [{ clone_id: 'A', event_type: 'commit_ready', payload: {} }],
    }, { enqueue: async (t) => { enqueued.push(t); } });
    expect(enqueued).toHaveLength(0);
    expect(d.state.phase).toBe('done');
  });

  it('ignores broadcasts from wrong clone', async () => {
    const d = new PairDispatcher(baseConfig);
    await d.onCycleComplete({
      idleClones: [],
      broadcasts: [{ clone_id: 'C', event_type: 'commit_ready', payload: { commit_ref: 'x', summary: 'y', files_changed: [] } }],
    }, { enqueue: async () => {} });
    expect(d.state.phase).toBe('writer_working');
  });
});
