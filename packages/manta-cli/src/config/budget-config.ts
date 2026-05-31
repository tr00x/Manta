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
  /**
   * Usage-aware caps. Claude Code is a subscription (Pro/Max), not pay-per-
   * token, so these are TOKEN ESTIMATES — a proxy for how much of your
   * subscription's usage/rate budget a cast consumes — not dollars.
   */
  tokenEstimatePerCast: number;
  tokenEstimatePerClone: number | 'auto';
  dailyTokenCap: number;
  /** Max clones a single cast may spawn concurrently. */
  maxParallelClones: number;
  /** Max casts allowed to start within a rolling hour (cast-rate cap). */
  maxCastsPerHour: number;
  tokenEstimates: Record<Mode, number>;
  autoDowngrade: ResolvedAutoDowngrade;
  charges: ResolvedCharges;
  triggersGlobalHourlyCap: number;
  /** Aghs-locked modes the operator has unlocked via config (spec Sec 6.6). */
  aghsUnlocked: Mode[];
}

// Per-clone token estimates by mode (rough order-of-magnitude proxies for
// subscription usage, NOT dollars). Heavier modes spawn more / longer-running
// clones, so they estimate higher.
const DEFAULT_TOKEN_ESTIMATES: Record<Mode, number> = {
  'recon-swarm': 150_000,
  'pair-programming': 150_000,
  'documentation-chase': 150_000,
  'forking-realities': 300_000,
  'test-storm': 300_000,
  'refactor-wave': 300_000,
  'bug-hunt': 300_000,
  'decoy': 300_000,
  'council': 500_000,
  'phantom-lance': 500_000,
};

export const BUDGET_DEFAULTS: ResolvedBudgetConfig = {
  tokenEstimatePerCast: 1_500_000,
  tokenEstimatePerClone: 'auto',
  dailyTokenCap: 5_000_000,
  maxParallelClones: 5,
  maxCastsPerHour: 6,
  tokenEstimates: { ...DEFAULT_TOKEN_ESTIMATES },
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
  aghsUnlocked: [],
};

export async function loadBudgetConfig(repoRoot: string): Promise<ResolvedBudgetConfig> {
  const configPath = path.join(repoRoot, '.manta', 'config', 'budget.json');

  let raw: unknown;
  try {
    const content = await fs.readFile(configPath, 'utf8');
    raw = JSON.parse(content);
  } catch {
    return { ...BUDGET_DEFAULTS, tokenEstimates: { ...DEFAULT_TOKEN_ESTIMATES } };
  }

  const parsed = BudgetConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return { ...BUDGET_DEFAULTS, tokenEstimates: { ...DEFAULT_TOKEN_ESTIMATES } };
  }

  const data = parsed.data;

  return {
    tokenEstimatePerCast: data.token_estimate_per_cast ?? BUDGET_DEFAULTS.tokenEstimatePerCast,
    tokenEstimatePerClone: data.token_estimate_per_clone ?? BUDGET_DEFAULTS.tokenEstimatePerClone,
    dailyTokenCap: data.daily_token_cap ?? BUDGET_DEFAULTS.dailyTokenCap,
    maxParallelClones: data.max_parallel_clones ?? BUDGET_DEFAULTS.maxParallelClones,
    maxCastsPerHour: data.max_casts_per_hour ?? BUDGET_DEFAULTS.maxCastsPerHour,
    tokenEstimates: {
      ...DEFAULT_TOKEN_ESTIMATES,
      ...(data.token_estimates ?? {}),
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
    aghsUnlocked: [...(data.aghs?.unlocked ?? [])],
  };
}
