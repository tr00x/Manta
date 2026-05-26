import type { ResolvedBudgetConfig } from '../config/budget-config.js';
import type { Mode } from '@manta/bus';

export interface CostEstimate {
  mode: Mode;
  cloneCount: number;
  perCloneCostUsd: number;
  totalEstimatedUsd: number;
  perCloneBudgetUsd: number;
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
  const perClone = config.costEstimates[mode] ?? 2.00;
  const perCloneBudget = perCloneBudgetOverride ??
    (config.perCloneUsd === 'auto' ? config.perCastUsd / cloneCount : config.perCloneUsd);
  return {
    mode,
    cloneCount,
    perCloneCostUsd: perClone,
    totalEstimatedUsd: perClone * cloneCount,
    perCloneBudgetUsd: perCloneBudget,
  };
}
