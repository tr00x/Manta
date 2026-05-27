export interface QualityGateResult {
  passed: boolean;
  hasDiff: boolean;
  tscOk: boolean;
  testsOk: boolean;
  errors: string[];
}

export interface DeadCloneEntry {
  cloneId: string;
  worktreePath: string;
  exitTime: number;
}

export interface MergeAllOptions {
  repoRoot: string;
  castId: string;
  deadClones: ReadonlyArray<DeadCloneEntry>;
  runQualityGate: (worktreePath: string) => Promise<QualityGateResult>;
  gitMerge: (repoRoot: string, branch: string) => Promise<{ hasConflicts: boolean }>;
  gitMergeAbort: (repoRoot: string) => Promise<void>;
}

export interface CloneGateEntry {
  cloneId: string;
  gate: QualityGateResult;
}

export type MergeAllVerdict =
  | 'all_merged'
  | 'partial_merge'
  | 'no_merges'
  | 'conflict_escalation';

export interface MergeAllResult {
  castId: string;
  verdict: MergeAllVerdict;
  merged: string[];
  skipped: string[];
  conflicted: string[];
  gateResults: CloneGateEntry[];
}

function branchName(castId: string, cloneId: string): string {
  return `manta/${castId}/${cloneId}`;
}

export async function runMergeAll(opts: MergeAllOptions): Promise<MergeAllResult> {
  const sorted = [...opts.deadClones].sort((a, b) => a.exitTime - b.exitTime);

  const merged: string[] = [];
  const skipped: string[] = [];
  const conflicted: string[] = [];
  const gateResults: CloneGateEntry[] = [];

  for (const clone of sorted) {
    const gate = await opts.runQualityGate(clone.worktreePath);
    gateResults.push({ cloneId: clone.cloneId, gate });

    if (!gate.passed || !gate.hasDiff) {
      skipped.push(clone.cloneId);
      continue;
    }

    const branch = branchName(opts.castId, clone.cloneId);
    const mergeResult = await opts.gitMerge(opts.repoRoot, branch);

    if (mergeResult.hasConflicts) {
      await opts.gitMergeAbort(opts.repoRoot);
      conflicted.push(clone.cloneId);
    } else {
      merged.push(clone.cloneId);
    }
  }

  let verdict: MergeAllVerdict;
  if (conflicted.length > 0) {
    verdict = 'conflict_escalation';
  } else if (merged.length === sorted.length) {
    verdict = 'all_merged';
  } else if (merged.length === 0) {
    verdict = 'no_merges';
  } else {
    verdict = 'partial_merge';
  }

  return {
    castId: opts.castId,
    verdict,
    merged,
    skipped,
    conflicted,
    gateResults,
  };
}
