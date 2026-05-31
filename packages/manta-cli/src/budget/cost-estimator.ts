import type { ResolvedBudgetConfig } from '../config/budget-config.js';
import type { Mode } from '@manta/bus';

/**
 * Usage estimate for a cast. Units are TOKEN ESTIMATES (a proxy for how much
 * of your Claude Code subscription's usage budget a cast consumes), not
 * dollars — Claude Code is a subscription, not pay-per-token.
 */
export interface CostEstimate {
  mode: Mode;
  cloneCount: number;
  perCloneTokens: number;
  totalEstimatedTokens: number;
  perCloneTokenBudget: number;
}

export function estimateCost(
  mode: Mode,
  cloneCount: number,
  config: ResolvedBudgetConfig,
  perCloneBudgetOverride?: number,
): CostEstimate {
  if (cloneCount < 1) {
    throw new Error(`estimateCost: cloneCount must be >= 1, got ${cloneCount}`);
  }
  const perClone = config.tokenEstimates[mode] ?? 200_000;
  const perCloneBudget = perCloneBudgetOverride ??
    (config.tokenEstimatePerClone === 'auto'
      ? config.tokenEstimatePerCast / cloneCount
      : config.tokenEstimatePerClone);
  return {
    mode,
    cloneCount,
    perCloneTokens: perClone,
    totalEstimatedTokens: perClone * cloneCount,
    perCloneTokenBudget: perCloneBudget,
  };
}
