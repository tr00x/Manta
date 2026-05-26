import type { CloneRecord } from '@manta/bus';

export type CastOutcome = 'success' | 'fail' | 'neutral';

export interface CastOutcomeInput {
  clones: CloneRecord[];
  budgetAborted: boolean;
}

const FAILURE_PATTERNS = ['heartbeat', 'startup grace', 'parent pid', 'budget'];

function isInfraFailure(reason: string | undefined): boolean {
  if (!reason) return false;
  const lower = reason.toLowerCase();
  return FAILURE_PATTERNS.some((p) => lower.includes(p));
}

function isManualKill(reason: string | undefined): boolean {
  if (!reason) return false;
  const lower = reason.toLowerCase();
  return lower.includes('manual') || lower.includes('kill');
}

export function classifyCastOutcome(input: CastOutcomeInput): CastOutcome {
  if (input.budgetAborted) return 'fail';

  if (input.clones.length === 0) return 'neutral';

  const hasInfraFailure = input.clones.some((c) => isInfraFailure(c.death_reason));
  if (hasInfraFailure) return 'fail';

  const allManualKill = input.clones.every(
    (c) => isManualKill(c.death_reason),
  );
  if (allManualKill) return 'neutral';

  return 'success';
}
