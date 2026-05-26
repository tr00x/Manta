import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { makeSampleRepo, type SampleRepoFixture } from './helpers/sampleRepo.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cliBin = path.join(repoRoot, 'packages/manta-cli/dist/bin/manta.cjs');

describe('charge-system e2e smoke', () => {
  let fx: SampleRepoFixture | undefined;

  afterAll(async () => {
    if (fx && process.env.MANTA_E2E_KEEP !== '1') {
      await fx.cleanup();
    }
  });

  it('charges, cost, and limit commands produce expected output on clean state', async () => {
    fx = await makeSampleRepo();

    // Ensure .manta/state directories exist (runtime creates them but we
    // want a clean path for the read-only commands)
    await fs.mkdir(path.join(fx.root, '.manta', 'state', 'casts'), { recursive: true });
    await fs.mkdir(path.join(fx.root, '.manta', 'state', 'timelines'), { recursive: true });
    await fs.mkdir(path.join(fx.root, '.manta', 'state', '.locks'), { recursive: true });

    // --- manta charges ---
    const chargesResult = await execa('node', [cliBin, 'charges'], {
      cwd: fx.root,
      reject: false,
      timeout: 15_000,
    });
    expect(chargesResult.exitCode).toBe(0);
    expect(chargesResult.stdout).toContain('Charges: 3 / 5');
    expect(chargesResult.stdout).toContain('State: nominal');
    expect(chargesResult.stdout).toContain('Mode availability:');
    expect(chargesResult.stdout).toContain('recon-swarm');

    // --- manta cost ---
    const costResult = await execa('node', [cliBin, 'cost'], {
      cwd: fx.root,
      reject: false,
      timeout: 15_000,
    });
    expect(costResult.exitCode).toBe(0);
    expect(costResult.stdout).toContain('$0.00 / $50.00');
    expect(costResult.stdout).toContain('No casts today');

    // --- manta cost week ---
    const costWeekResult = await execa('node', [cliBin, 'cost', 'week'], {
      cwd: fx.root,
      reject: false,
      timeout: 15_000,
    });
    expect(costWeekResult.exitCode).toBe(0);
    expect(costWeekResult.stdout).toContain('This week:');

    // --- manta limit get ---
    const limitResult = await execa('node', [cliBin, 'limit', 'get'], {
      cwd: fx.root,
      reject: false,
      timeout: 15_000,
    });
    expect(limitResult.exitCode).toBe(0);
    expect(limitResult.stdout).toContain('per_cast_usd:');
    expect(limitResult.stdout).toContain('daily_cap_usd:');
    expect(limitResult.stdout).toContain('charges.initial:');

    // --- manta limit get <specific key> ---
    const limitKeyResult = await execa('node', [cliBin, 'limit', 'get', 'daily_cap_usd'], {
      cwd: fx.root,
      reject: false,
      timeout: 15_000,
    });
    expect(limitKeyResult.exitCode).toBe(0);
    expect(limitKeyResult.stdout).toContain('daily_cap_usd: 50');

    // --- manta limit set ---
    const setResult = await execa('node', [cliBin, 'limit', 'set', 'daily_cap_usd', '100'], {
      cwd: fx.root,
      reject: false,
      timeout: 15_000,
    });
    expect(setResult.exitCode).toBe(0);
    expect(setResult.stdout).toContain('50 → 100');

    // Verify config persisted
    const configPath = path.join(fx.root, '.manta', 'config', 'budget.json');
    const raw = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.daily_cap_usd).toBe(100);

    // Verify updated value visible via get
    const verifyResult = await execa('node', [cliBin, 'limit', 'get', 'daily_cap_usd'], {
      cwd: fx.root,
      reject: false,
      timeout: 15_000,
    });
    expect(verifyResult.stdout).toContain('daily_cap_usd: 100');
  });

  it('charges.json is unchanged after read-only commands', async () => {
    if (!fx) return;

    // charges.json should exist after charges command created default state
    const chargesPath = path.join(fx.root, '.manta', 'state', 'charges.json');
    let chargesBefore: string;
    try {
      chargesBefore = await fs.readFile(chargesPath, 'utf-8');
    } catch {
      // File may not exist if charges was the first read - that's OK
      return;
    }

    // Run charges again
    await execa('node', [cliBin, 'charges'], {
      cwd: fx.root,
      reject: false,
      timeout: 15_000,
    });

    const chargesAfter = await fs.readFile(chargesPath, 'utf-8');
    const before = JSON.parse(chargesBefore);
    const after = JSON.parse(chargesAfter);
    expect(after.current_charges).toBe(before.current_charges);
    expect(after.total_casts).toBe(before.total_casts);
  });
});
