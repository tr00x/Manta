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
    // Claude Code is a subscription, not pay-per-token — the only tunable cast
    // limit is parallelism. Cost/charges/cooldown/cast-rate accounting is gone.
    expect(config.maxParallelClones).toBe(BUDGET_DEFAULTS.maxParallelClones);
    expect(config.triggersGlobalHourlyCap).toBe(6);
    expect(config.aghsUnlocked).toEqual([]);
  });

  it('resolves max_parallel_clones override from file', async () => {
    const configDir = path.join(tmpDir, '.manta', 'config');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'budget.json'),
      JSON.stringify({ max_parallel_clones: 3 }),
    );
    const config = await loadBudgetConfig(tmpDir);
    expect(config.maxParallelClones).toBe(3);
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
      'maxParallelClones', 'triggersGlobalHourlyCap', 'aghsUnlocked',
    ];
    for (const key of keys) {
      expect(config[key]).toBeDefined();
    }
  });

  it('resolves aghs.unlocked from file', async () => {
    const configDir = path.join(tmpDir, '.manta', 'config');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'budget.json'),
      JSON.stringify({ aghs: { unlocked: ['council'] } }),
    );
    const config = await loadBudgetConfig(tmpDir);
    expect(config.aghsUnlocked).toEqual(['council']);
  });

  it('ignores malformed config file and returns defaults', async () => {
    const configDir = path.join(tmpDir, '.manta', 'config');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(configDir, 'budget.json'), 'not json');
    const config = await loadBudgetConfig(tmpDir);
    expect(config.maxParallelClones).toBe(BUDGET_DEFAULTS.maxParallelClones);
  });
});
