import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { BudgetConfigSchema, type Mode } from '@manta/bus';

export interface ResolvedAutoDowngrade {
  enabled: boolean;
  confirm: boolean;
  minClones: number;
}

export interface ResolvedCharges {
  initial: number;
  max: number;
  min: number;
  idleRecoveryMinutes: number;
  cooldownHours: number;
}

export interface ResolvedBudgetConfig {
  perCastUsd: number;
  perCloneUsd: number | 'auto';
  dailyCapUsd: number;
  costEstimates: Record<Mode, number>;
  autoDowngrade: ResolvedAutoDowngrade;
  charges: ResolvedCharges;
  triggersGlobalHourlyCap: number;
}

const DEFAULT_COST_ESTIMATES: Record<Mode, number> = {
  'recon-swarm': 1.50,
  'pair-programming': 1.50,
  'documentation-chase': 1.50,
  'forking-realities': 3.00,
  'test-storm': 3.00,
  'refactor-wave': 3.00,
  'bug-hunt': 3.00,
  'decoy': 3.00,
  'council': 5.00,
  'phantom-lance': 5.00,
};

export const BUDGET_DEFAULTS: ResolvedBudgetConfig = {
  perCastUsd: 15,
  perCloneUsd: 'auto',
  dailyCapUsd: 50,
  costEstimates: { ...DEFAULT_COST_ESTIMATES },
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
  triggersGlobalHourlyCap: 6,
};

export async function loadBudgetConfig(repoRoot: string): Promise<ResolvedBudgetConfig> {
  const configPath = path.join(repoRoot, '.manta', 'config', 'budget.json');

  let raw: unknown;
  try {
    const content = await fs.readFile(configPath, 'utf8');
    raw = JSON.parse(content);
  } catch {
    return { ...BUDGET_DEFAULTS, costEstimates: { ...DEFAULT_COST_ESTIMATES } };
  }

  const parsed = BudgetConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return { ...BUDGET_DEFAULTS, costEstimates: { ...DEFAULT_COST_ESTIMATES } };
  }

  const data = parsed.data;

  return {
    perCastUsd: data.per_cast_usd ?? BUDGET_DEFAULTS.perCastUsd,
    perCloneUsd: data.per_clone_usd ?? BUDGET_DEFAULTS.perCloneUsd,
    dailyCapUsd: data.daily_cap_usd ?? BUDGET_DEFAULTS.dailyCapUsd,
    costEstimates: {
      ...DEFAULT_COST_ESTIMATES,
      ...(data.cost_estimates ?? {}),
    } as Record<Mode, number>,
    autoDowngrade: {
      enabled: data.auto_downgrade?.enabled ?? BUDGET_DEFAULTS.autoDowngrade.enabled,
      confirm: data.auto_downgrade?.confirm ?? BUDGET_DEFAULTS.autoDowngrade.confirm,
      minClones: data.auto_downgrade?.min_clones ?? BUDGET_DEFAULTS.autoDowngrade.minClones,
    },
    charges: {
      initial: data.charges?.initial ?? BUDGET_DEFAULTS.charges.initial,
      max: data.charges?.max ?? BUDGET_DEFAULTS.charges.max,
      min: data.charges?.min ?? BUDGET_DEFAULTS.charges.min,
      idleRecoveryMinutes: data.charges?.idle_recovery_minutes ?? BUDGET_DEFAULTS.charges.idleRecoveryMinutes,
      cooldownHours: data.charges?.cooldown_hours ?? BUDGET_DEFAULTS.charges.cooldownHours,
    },
    triggersGlobalHourlyCap:
      data.triggers?.global_hourly_cap ?? BUDGET_DEFAULTS.triggersGlobalHourlyCap,
  };
}
