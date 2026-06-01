import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { BudgetConfigSchema, type Mode } from '@manta/bus';

export interface ResolvedBudgetConfig {
  /**
   * The ONLY real cast constraint. Claude Code is a subscription (Pro/Max), not
   * pay-per-token, so dollar/charge/cooldown/cast-rate accounting is meaningless
   * — the single guard that protects the machine and the subscription rate limit
   * is how many clone processes run at once.
   */
  maxParallelClones: number;
  /** Phase 7c reactive triggers: global hourly cap spanning ALL triggers. */
  triggersGlobalHourlyCap: number;
  /** Aghs-locked modes the operator has unlocked via config (spec Sec 6.6). */
  aghsUnlocked: Mode[];
}

export const BUDGET_DEFAULTS: ResolvedBudgetConfig = {
  maxParallelClones: 5,
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
    return { ...BUDGET_DEFAULTS };
  }

  const parsed = BudgetConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return { ...BUDGET_DEFAULTS };
  }

  const data = parsed.data;

  return {
    maxParallelClones: data.max_parallel_clones ?? BUDGET_DEFAULTS.maxParallelClones,
    triggersGlobalHourlyCap:
      data.triggers?.global_hourly_cap ?? BUDGET_DEFAULTS.triggersGlobalHourlyCap,
    aghsUnlocked: [...(data.aghs?.unlocked ?? [])],
  };
}
