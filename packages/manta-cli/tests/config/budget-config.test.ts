import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadBudgetConfig, BUDGET_DEFAULTS, type ResolvedBudgetConfig } from '../../src/config/budget-config';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-budget-cfg-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('loadBudgetConfig', () => {
  it('returns defaults when no config file exists', async () => {
    const config = await loadBudgetConfig(tmpDir);
    expect(config.perCastUsd).toBe(BUDGET_DEFAULTS.perCastUsd);
    expect(config.perCloneUsd).toBe('auto');
    expect(config.dailyCapUsd).toBe(BUDGET_DEFAULTS.dailyCapUsd);
    expect(config.autoDowngrade.enabled).toBe(true);
    expect(config.autoDowngrade.confirm).toBe(true);
    expect(config.autoDowngrade.minClones).toBe(1);
    expect(config.charges.initial).toBe(3);
    expect(config.charges.max).toBe(5);
    expect(config.charges.min).toBe(-1);
    expect(config.charges.idleRecoveryMinutes).toBe(30);
    expect(config.charges.cooldownHours).toBe(24);
  });

  it('all fields in ResolvedBudgetConfig are required (not undefined)', async () => {
    const config = await loadBudgetConfig(tmpDir);
    const keys: (keyof ResolvedBudgetConfig)[] = [
      'perCastUsd', 'perCloneUsd', 'dailyCapUsd',
      'costEstimates', 'autoDowngrade', 'charges',
    ];
    for (const key of keys) {
      expect(config[key]).toBeDefined();
    }
  });

  it('costEstimates has defaults for known modes', async () => {
    const config = await loadBudgetConfig(tmpDir);
    expect(config.costEstimates['recon-swarm']).toBe(1.50);
    expect(config.costEstimates['forking-realities']).toBe(3.00);
  });

  it('merges partial config from file', async () => {
    const configDir = path.join(tmpDir, '.manta', 'config');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'budget.json'),
      JSON.stringify({ daily_cap_usd: 100, per_cast_usd: 25 }),
    );
    const config = await loadBudgetConfig(tmpDir);
    expect(config.dailyCapUsd).toBe(100);
    expect(config.perCastUsd).toBe(25);
    expect(config.perCloneUsd).toBe('auto');
    expect(config.charges.max).toBe(5);
  });

  it('merges nested auto_downgrade partial', async () => {
    const configDir = path.join(tmpDir, '.manta', 'config');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'budget.json'),
      JSON.stringify({ auto_downgrade: { min_clones: 2 } }),
    );
    const config = await loadBudgetConfig(tmpDir);
    expect(config.autoDowngrade.minClones).toBe(2);
    expect(config.autoDowngrade.enabled).toBe(true);
    expect(config.autoDowngrade.confirm).toBe(true);
  });

  it('merges nested charges partial', async () => {
    const configDir = path.join(tmpDir, '.manta', 'config');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'budget.json'),
      JSON.stringify({ charges: { max: 10, cooldown_hours: 48 } }),
    );
    const config = await loadBudgetConfig(tmpDir);
    expect(config.charges.max).toBe(10);
    expect(config.charges.cooldownHours).toBe(48);
    expect(config.charges.initial).toBe(3);
    expect(config.charges.min).toBe(-1);
  });

  it('merges cost_estimates partial', async () => {
    const configDir = path.join(tmpDir, '.manta', 'config');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'budget.json'),
      JSON.stringify({ cost_estimates: { 'recon-swarm': 2.00 } }),
    );
    const config = await loadBudgetConfig(tmpDir);
    expect(config.costEstimates['recon-swarm']).toBe(2.00);
    expect(config.costEstimates['forking-realities']).toBe(3.00);
  });

  it('ignores malformed config file and returns defaults', async () => {
    const configDir = path.join(tmpDir, '.manta', 'config');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(configDir, 'budget.json'), 'not json');
    const config = await loadBudgetConfig(tmpDir);
    expect(config.perCastUsd).toBe(BUDGET_DEFAULTS.perCastUsd);
  });

  it('perCloneUsd can be numeric from config', async () => {
    const configDir = path.join(tmpDir, '.manta', 'config');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'budget.json'),
      JSON.stringify({ per_clone_usd: 8 }),
    );
    const config = await loadBudgetConfig(tmpDir);
    expect(config.perCloneUsd).toBe(8);
  });
});
