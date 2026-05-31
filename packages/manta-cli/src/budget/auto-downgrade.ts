import type { Mode } from '@manta/bus';
import type { ResolvedBudgetConfig } from '../config/budget-config.js';
import { estimateCost, type CostEstimate } from './cost-estimator.js';

export interface DowngradeOption {
  label: string;
  mode: Mode;
  cloneCount: number;
  estimatedTokens: number;
  viable: boolean;
}

export interface DowngradeAdvice {
  originalEstimate: CostEstimate;
  remainingTokenBudget: number;
  options: DowngradeOption[];
}

const CHEAPER_MODE_MAP: Partial<Record<Mode, Mode>> = {
  'forking-realities': 'recon-swarm',
  'test-storm': 'recon-swarm',
  'refactor-wave': 'recon-swarm',
  'bug-hunt': 'recon-swarm',
  'decoy': 'recon-swarm',
  'council': 'forking-realities',
  'phantom-lance': 'forking-realities',
};

export function computeDowngradeOptions(
  mode: Mode,
  cloneCount: number,
  remainingTokenBudget: number,
  config: ResolvedBudgetConfig,
): DowngradeAdvice {
  const originalEstimate = estimateCost(mode, cloneCount, config);

  if (!config.autoDowngrade.enabled) {
    return { originalEstimate, remainingTokenBudget, options: [] };
  }

  const options: DowngradeOption[] = [];

  for (let n = cloneCount - 1; n >= config.autoDowngrade.minClones; n--) {
    const est = estimateCost(mode, n, config);
    options.push({
      label: `${mode} × ${n}`,
      mode,
      cloneCount: n,
      estimatedTokens: est.totalEstimatedTokens,
      viable: est.totalEstimatedTokens <= remainingTokenBudget,
    });
  }

  const cheaperMode = CHEAPER_MODE_MAP[mode];
  if (cheaperMode) {
    for (let n = cloneCount; n >= config.autoDowngrade.minClones; n--) {
      const est = estimateCost(cheaperMode, n, config);
      options.push({
        label: `${cheaperMode} × ${n}`,
        mode: cheaperMode,
        cloneCount: n,
        estimatedTokens: est.totalEstimatedTokens,
        viable: est.totalEstimatedTokens <= remainingTokenBudget,
      });
    }
  }

  return { originalEstimate, remainingTokenBudget, options };
}
