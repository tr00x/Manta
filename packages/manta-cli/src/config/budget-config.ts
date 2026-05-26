import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BudgetConfigSchema, type BudgetConfig } from '@manta/bus';

export interface ResolvedBudgetConfig {
  perCastUsd: number;
  perCloneUsd: number | 'auto';
  dailyCapUsd: number;
  costEstimates: Record<string, number>;
  autoDowngrade: {
    enabled: boolean;
    confirm: boolean;
    minClones: number;
  };
  charges: {
    initial: number;
    max: number;
    min: number;
    idleRecoveryMinutes: number;
    cooldownHours: number;
  };
}

export const DEFAULT_BUDGET_CONFIG: ResolvedBudgetConfig = {
  perCastUsd: 15,
  perCloneUsd: 'auto',
  dailyCapUsd: 50,
  costEstimates: {
    'recon-swarm': 1.5,
    'forking-realities': 3.0,
    'pair-programming': 2.0,
    'test-storm': 3.0,
    'bug-hunt': 2.5,
    'refactor-wave': 3.0,
    'documentation-chase': 1.0,
    'phantom-lance': 4.0,
    'council': 2.0,
    'decoy': 1.5,
  },
  autoDowngrade: {
    enabled: true,
    confirm: true,
    minClones: 1,
  },
  charges: {
    initial: 3,
    max: 5,
    min: -1,
    idleRecoveryMinutes: 30,
    cooldownHours: 24,
  },
};

function deepMerge(
  defaults: ResolvedBudgetConfig,
  overrides: Partial<BudgetConfig>,
): ResolvedBudgetConfig {
  return {
    perCastUsd: overrides.per_cast_usd ?? defaults.perCastUsd,
    perCloneUsd: overrides.per_clone_usd ?? defaults.perCloneUsd,
    dailyCapUsd: overrides.daily_cap_usd ?? defaults.dailyCapUsd,
    costEstimates: overrides.cost_estimates
      ? { ...defaults.costEstimates, ...overrides.cost_estimates }
      : defaults.costEstimates,
    autoDowngrade: overrides.auto_downgrade
      ? {
          enabled: overrides.auto_downgrade.enabled ?? defaults.autoDowngrade.enabled,
          confirm: overrides.auto_downgrade.confirm ?? defaults.autoDowngrade.confirm,
          minClones: overrides.auto_downgrade.min_clones ?? defaults.autoDowngrade.minClones,
        }
      : defaults.autoDowngrade,
    charges: overrides.charges
      ? {
          initial: overrides.charges.initial ?? defaults.charges.initial,
          max: overrides.charges.max ?? defaults.charges.max,
          min: overrides.charges.min ?? defaults.charges.min,
          idleRecoveryMinutes:
            overrides.charges.idle_recovery_minutes ?? defaults.charges.idleRecoveryMinutes,
          cooldownHours: overrides.charges.cooldown_hours ?? defaults.charges.cooldownHours,
        }
      : defaults.charges,
  };
}

export async function loadBudgetConfig(repoRoot: string): Promise<ResolvedBudgetConfig> {
  const configPath = join(repoRoot, '.manta', 'config', 'budget.json');
  try {
    const raw = await readFile(configPath, 'utf-8');
    const parsed = BudgetConfigSchema.parse(JSON.parse(raw));
    return deepMerge(DEFAULT_BUDGET_CONFIG, parsed);
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return DEFAULT_BUDGET_CONFIG;
    }
    throw err;
  }
}
