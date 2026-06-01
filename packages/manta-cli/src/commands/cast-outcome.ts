import type { CloneRecord } from '@manta/bus';

/**
 * Classify how a cast ended, for the `cast.settlement` signal and post-run
 * summaries. This is a pure read of the clones' final death reasons — NOT a
 * billing concept (charges/cooldown were removed; Claude Code is
 * subscription-based). It answers "did this cast succeed, fail, or end
 * inconclusively?" so the operator and tests get a single settlement verdict.
 */
export type CastOutcome = 'success' | 'fail' | 'neutral';

export interface CastOutcomeInput {
  clones: CloneRecord[];
  /** The tick-loop aborted the cast (e.g. operator abort, hard cap). */
  aborted: boolean;
}

// Infra failures the death-detector records — these mean the cast did not get
// a fair run (the clone never did real work), so the cast counts as a failure.
const FAILURE_PATTERNS = ['heartbeat', 'startup grace', 'startup hard cap', 'parent pid'];

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
  if (input.aborted) return 'fail';

  if (input.clones.length === 0) return 'neutral';

  const hasInfraFailure = input.clones.some((c) => isInfraFailure(c.death_reason));
  if (hasInfraFailure) return 'fail';

  const allManualKill = input.clones.every((c) => isManualKill(c.death_reason));
  if (allManualKill) return 'neutral';

  return 'success';
}
