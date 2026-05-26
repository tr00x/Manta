import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadBudgetConfig, DEFAULT_BUDGET_CONFIG } from '../../src/config/budget-config.js';

describe('loadBudgetConfig', () => {
  let tmpDir: string | undefined;
  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  async function makeTmpRepo(): Promise<string> {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'budget-config-test-'));
    return tmpDir;
  }

  it('returns defaults when config file missing', async () => {
    const root = await makeTmpRepo();
    const config = await loadBudgetConfig(root);
    expect(config).toEqual(DEFAULT_BUDGET_CONFIG);
  });

  it('parses and merges partial config (only daily_cap_usd)', async () => {
    const root = await makeTmpRepo();
    const configDir = path.join(root, '.manta', 'config');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'budget.json'),
      JSON.stringify({ daily_cap_usd: 100 }),
    );
    const config = await loadBudgetConfig(root);
    expect(config.dailyCapUsd).toBe(100);
    expect(config.perCastUsd).toBe(DEFAULT_BUDGET_CONFIG.perCastUsd);
    expect(config.charges).toEqual(DEFAULT_BUDGET_CONFIG.charges);
  });

  it('parses full config', async () => {
    const root = await makeTmpRepo();
    const configDir = path.join(root, '.manta', 'config');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'budget.json'),
      JSON.stringify({
        per_cast_usd: 20,
        per_clone_usd: 8,
        daily_cap_usd: 80,
        auto_downgrade: { enabled: false, confirm: false, min_clones: 2 },
        charges: { initial: 5, max: 10, min: -2, idle_recovery_minutes: 15, cooldown_hours: 12 },
      }),
    );
    const config = await loadBudgetConfig(root);
    expect(config.perCastUsd).toBe(20);
    expect(config.perCloneUsd).toBe(8);
    expect(config.dailyCapUsd).toBe(80);
    expect(config.autoDowngrade.enabled).toBe(false);
    expect(config.charges.initial).toBe(5);
    expect(config.charges.cooldownHours).toBe(12);
  });

  it('rejects invalid config (negative daily_cap_usd)', async () => {
    const root = await makeTmpRepo();
    const configDir = path.join(root, '.manta', 'config');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'budget.json'),
      JSON.stringify({ daily_cap_usd: -10 }),
    );
    await expect(loadBudgetConfig(root)).rejects.toThrow();
  });

  it('preserves unset fields from defaults', async () => {
    const root = await makeTmpRepo();
    const configDir = path.join(root, '.manta', 'config');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'budget.json'),
      JSON.stringify({ charges: { max: 10 } }),
    );
    const config = await loadBudgetConfig(root);
    expect(config.charges.max).toBe(10);
    expect(config.charges.initial).toBe(DEFAULT_BUDGET_CONFIG.charges.initial);
    expect(config.charges.min).toBe(DEFAULT_BUDGET_CONFIG.charges.min);
  });

  it('per_clone_usd: "auto" passes through correctly', async () => {
    const root = await makeTmpRepo();
    const configDir = path.join(root, '.manta', 'config');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'budget.json'),
      JSON.stringify({ per_clone_usd: 'auto' }),
    );
    const config = await loadBudgetConfig(root);
    expect(config.perCloneUsd).toBe('auto');
  });
});
