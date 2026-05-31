import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadBudgetConfig, BUDGET_DEFAULTS, type ResolvedBudgetConfig } from '../../src/config/budget-config.js';

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
    expect(config.tokenEstimatePerCast).toBe(BUDGET_DEFAULTS.tokenEstimatePerCast);
    expect(config.tokenEstimatePerClone).toBe('auto');
    expect(config.dailyTokenCap).toBe(BUDGET_DEFAULTS.dailyTokenCap);
    expect(config.autoDowngrade.enabled).toBe(true);
    expect(config.autoDowngrade.confirm).toBe(true);
    expect(config.autoDowngrade.minClones).toBe(1);
    expect(config.charges.initial).toBe(3);
    expect(config.charges.max).toBe(5);
    expect(config.charges.min).toBe(-1);
    expect(config.charges.idleRecoveryMinutes).toBe(30);
    expect(config.charges.cooldownHours).toBe(24);
    expect(config.triggersGlobalHourlyCap).toBe(6);
  });

  it('resolves triggers.global_hourly_cap override from file', async () => {
    const configDir = path.join(tmpDir, '.manta', 'config');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'budget.json'),
      JSON.stringify({ triggers: { global_hourly_cap: 2 } }),
    );
    const config = await loadBudgetConfig(tmpDir);
    expect(config.triggersGlobalHourlyCap).toBe(2);
  });

  it('all fields in ResolvedBudgetConfig are required (not undefined)', async () => {
    const config = await loadBudgetConfig(tmpDir);
    const keys: (keyof ResolvedBudgetConfig)[] = [
      'tokenEstimatePerCast', 'tokenEstimatePerClone', 'dailyTokenCap',
      'tokenEstimates', 'autoDowngrade', 'charges', 'triggersGlobalHourlyCap',
    ];
    for (const key of keys) {
      expect(config[key]).toBeDefined();
    }
  });

  it('tokenEstimates has defaults for known modes', async () => {
    const config = await loadBudgetConfig(tmpDir);
    expect(config.tokenEstimates['recon-swarm']).toBe(150_000);
    expect(config.tokenEstimates['forking-realities']).toBe(300_000);
  });

  it('merges partial config from file', async () => {
    const configDir = path.join(tmpDir, '.manta', 'config');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'budget.json'),
      JSON.stringify({ daily_token_cap: 100, token_estimate_per_cast: 25 }),
    );
    const config = await loadBudgetConfig(tmpDir);
    expect(config.dailyTokenCap).toBe(100);
    expect(config.tokenEstimatePerCast).toBe(25);
    expect(config.tokenEstimatePerClone).toBe('auto');
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

  it('merges token_estimates partial', async () => {
    const configDir = path.join(tmpDir, '.manta', 'config');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'budget.json'),
      JSON.stringify({ token_estimates: { 'recon-swarm': 2.00 } }),
    );
    const config = await loadBudgetConfig(tmpDir);
    expect(config.tokenEstimates['recon-swarm']).toBe(2.00);
    expect(config.tokenEstimates['forking-realities']).toBe(3.00);
  });

  it('ignores malformed config file and returns defaults', async () => {
    const configDir = path.join(tmpDir, '.manta', 'config');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(configDir, 'budget.json'), 'not json');
    const config = await loadBudgetConfig(tmpDir);
    expect(config.tokenEstimatePerCast).toBe(BUDGET_DEFAULTS.tokenEstimatePerCast);
  });

  it('tokenEstimatePerClone can be numeric from config', async () => {
    const configDir = path.join(tmpDir, '.manta', 'config');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'budget.json'),
      JSON.stringify({ token_estimate_per_clone: 8 }),
    );
    const config = await loadBudgetConfig(tmpDir);
    expect(config.tokenEstimatePerClone).toBe(8);
  });
});
