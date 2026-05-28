import { describe, it, expect, vi } from 'vitest';
import type { MergeAllOptions, QualityGateResult } from '../src/merge-all';
import { runMergeAll } from '../src/merge-all';

function makeDeadClone(
  id: string,
  exitTime: number,
): { cloneId: string; worktreePath: string; exitTime: number } {
  return { cloneId: id, worktreePath: `/tmp/wt-${id}`, exitTime };
}

function gatePass(): QualityGateResult {
  return { passed: true, hasDiff: true, tscOk: true, testsOk: true, errors: [] };
}

function gateFail(reasons: string[]): QualityGateResult {
  return { passed: false, hasDiff: true, tscOk: false, testsOk: false, errors: reasons };
}

function gateEmptyDiff(): QualityGateResult {
  return { passed: false, hasDiff: false, tscOk: true, testsOk: true, errors: ['empty diff'] };
}

function baseOpts(overrides: Partial<MergeAllOptions> = {}): MergeAllOptions {
  return {
    repoRoot: '/tmp/repo',
    castId: 'cast-test-1',
    deadClones: [
      makeDeadClone('A', 100),
      makeDeadClone('B', 200),
    ],
    runQualityGate: vi.fn().mockResolvedValue(gatePass()),
    gitMerge: vi.fn().mockResolvedValue({ hasConflicts: false }),
    gitMergeAbort: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('runMergeAll', () => {
  it('merges all clones when all pass quality gate (all_merged)', async () => {
    const opts = baseOpts();
    const result = await runMergeAll(opts);
    expect(result.verdict).toBe('all_merged');
    expect(result.merged).toEqual(['A', 'B']);
    expect(result.skipped).toEqual([]);
    expect(result.conflicted).toEqual([]);
    expect(opts.gitMerge).toHaveBeenCalledTimes(2);
  });

  it('skips clone that fails quality gate (partial_merge)', async () => {
    const runQualityGate = vi.fn()
      .mockResolvedValueOnce(gatePass())
      .mockResolvedValueOnce(gateFail(['tsc failed']));
    const opts = baseOpts({ runQualityGate });
    const result = await runMergeAll(opts);
    expect(result.verdict).toBe('partial_merge');
    expect(result.merged).toEqual(['A']);
    expect(result.skipped).toEqual(['B']);
    expect(result.conflicted).toEqual([]);
    expect(opts.gitMerge).toHaveBeenCalledTimes(1);
  });

  it('handles merge conflict — escalates and continues with others (conflict_escalation)', async () => {
    const deadClones = [
      makeDeadClone('A', 100),
      makeDeadClone('B', 200),
      makeDeadClone('C', 300),
    ];
    const gitMerge = vi.fn()
      .mockResolvedValueOnce({ hasConflicts: true })
      .mockResolvedValueOnce({ hasConflicts: false })
      .mockResolvedValueOnce({ hasConflicts: false });
    const gitMergeAbort = vi.fn().mockResolvedValue(undefined);
    const opts = baseOpts({ deadClones, gitMerge, gitMergeAbort });
    const result = await runMergeAll(opts);
    expect(result.verdict).toBe('conflict_escalation');
    expect(result.conflicted).toEqual(['A']);
    expect(result.merged).toEqual(['B', 'C']);
    expect(gitMergeAbort).toHaveBeenCalledTimes(1);
  });

  it('returns no_merges when all clones fail quality gate', async () => {
    const runQualityGate = vi.fn().mockResolvedValue(gateFail(['tsc failed']));
    const opts = baseOpts({ runQualityGate });
    const result = await runMergeAll(opts);
    expect(result.verdict).toBe('no_merges');
    expect(result.merged).toEqual([]);
    expect(result.skipped).toEqual(['A', 'B']);
  });

  it('skips clone with empty diff silently (empty-diff-skip)', async () => {
    const runQualityGate = vi.fn()
      .mockResolvedValueOnce(gateEmptyDiff())
      .mockResolvedValueOnce(gatePass());
    const opts = baseOpts({ runQualityGate });
    const result = await runMergeAll(opts);
    expect(result.verdict).toBe('partial_merge');
    expect(result.merged).toEqual(['B']);
    expect(result.skipped).toEqual(['A']);
    expect(opts.gitMerge).toHaveBeenCalledTimes(1);
  });

  it('processes clones sorted by exit time (earliest first)', async () => {
    const deadClones = [
      makeDeadClone('B', 300),
      makeDeadClone('A', 100),
      makeDeadClone('C', 200),
    ];
    const mergeOrder: string[] = [];
    const gitMerge = vi.fn().mockImplementation((_root: string, branch: string) => {
      const cloneId = branch.split('/').pop()!;
      mergeOrder.push(cloneId);
      return Promise.resolve({ hasConflicts: false });
    });
    const opts = baseOpts({ deadClones, gitMerge });
    const result = await runMergeAll(opts);
    expect(result.verdict).toBe('all_merged');
    expect(mergeOrder).toEqual(['A', 'C', 'B']);
  });

  it('returns quality gate results per clone in gateResults', async () => {
    const gate1 = gatePass();
    const gate2 = gateFail(['tests failed']);
    const runQualityGate = vi.fn()
      .mockResolvedValueOnce(gate1)
      .mockResolvedValueOnce(gate2);
    const opts = baseOpts({ runQualityGate });
    const result = await runMergeAll(opts);
    expect(result.gateResults).toHaveLength(2);
    expect(result.gateResults[0]).toEqual({ cloneId: 'A', gate: gate1 });
    expect(result.gateResults[1]).toEqual({ cloneId: 'B', gate: gate2 });
  });

  it('report writer receives correct data when provided', async () => {
    const opts = baseOpts();
    const result = await runMergeAll(opts);
    expect(result.merged).toEqual(['A', 'B']);
    expect(result.verdict).toBe('all_merged');
  });
});
