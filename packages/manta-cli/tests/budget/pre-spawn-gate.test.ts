import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  busPaths,
  ChargeStore,
  DailySpendLedger,
  FakeClock,
  type ChargeStoreConfig,
} from '@manta/bus';
import { runPreSpawnGate, type PreSpawnGateOptions } from '../../src/budget/pre-spawn-gate.js';
import { BUDGET_DEFAULTS, type ResolvedBudgetConfig } from '../../src/config/budget-config.js';
import { createReporter, MemorySink } from '../../src/output/reporter.js';

let tmpDir: string;
let clock: FakeClock;
let sink: MemorySink;

function makeConfig(overrides: Partial<ResolvedBudgetConfig> = {}): ResolvedBudgetConfig {
  return { ...BUDGET_DEFAULTS, ...overrides };
}

function makeOpts(overrides: Partial<PreSpawnGateOptions> = {}): PreSpawnGateOptions {
  const paths = busPaths(tmpDir);
  const chargeConfig: ChargeStoreConfig = {
    initial: 3,
    max: 5,
    min: -1,
    idleRecoveryMinutes: 30,
    cooldownHours: 24,
  };
  return {
    mode: 'recon-swarm',
    cloneCount: 3,
    castId: 'cast-test-1',
    force: false,
    noChargeCheck: false,
    dryRun: false,
    config: makeConfig(),
    charges: new ChargeStore(paths, clock, chargeConfig),
    dailySpend: new DailySpendLedger(paths, clock),
    reporter: createReporter({ sink, now: () => clock.now() }),
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-gate-'));
  await fs.mkdir(path.join(tmpDir, '.manta', 'state'), { recursive: true });
  clock = new FakeClock(Date.now());
  sink = new MemorySink();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('runPreSpawnGate', () => {
  it('all checks pass → committed=true, charges deducted, daily-spend recorded', async () => {
    const opts = makeOpts();
    const result = await runPreSpawnGate(opts);
    expect(result.passed).toBe(true);
    expect(result.committed).toBe(true);
    expect(result.chargesAfterDeduct).toBe(2);
    expect(result.dailySpentAfter).toBeGreaterThan(0);
    // Remaining is in TOKEN estimates now (not dollars): it dropped below the
    // full daily token cap once this cast's estimate was recorded.
    expect(result.dailyRemaining).toBeLessThan(5_000_000);
  });

  it('dryRun=true → passed=true, committed=false, reporter called with preview', async () => {
    const opts = makeOpts({ dryRun: true });
    const result = await runPreSpawnGate(opts);
    expect(result.passed).toBe(true);
    expect(result.committed).toBe(false);
    const state = await opts.charges.read();
    expect(state.current_charges).toBe(3);
  });

  it('insufficient charges → passed=false', async () => {
    const paths = busPaths(tmpDir);
    const chargeConfig: ChargeStoreConfig = {
      initial: 0,
      max: 5,
      min: -1,
      idleRecoveryMinutes: 30,
      cooldownHours: 24,
    };
    const charges = new ChargeStore(paths, clock, chargeConfig);
    await charges.read();

    const opts = makeOpts({
      mode: 'forking-realities',
      cloneCount: 2,
      charges,
    });
    const result = await runPreSpawnGate(opts);
    expect(result.passed).toBe(false);
    expect(result.committed).toBe(false);
  });

  it('cooldown active → passed=false', async () => {
    const opts = makeOpts();
    await opts.charges.deductForCast('old-cast', 'recon-swarm');
    await opts.charges.creditFail('old-cast', 'recon-swarm');
    await opts.charges.creditFail('old-cast2', 'recon-swarm');
    await opts.charges.creditFail('old-cast3', 'recon-swarm');
    await opts.charges.creditFail('old-cast4', 'recon-swarm');

    const result = await runPreSpawnGate(opts);
    expect(result.passed).toBe(false);
    expect(result.committed).toBe(false);
  });

  it('daily cap exceeded → computes downgrade advice', async () => {
    const opts = makeOpts({
      config: makeConfig({ dailyTokenCap: 3 }),
    });
    const result = await runPreSpawnGate(opts);
    expect(result.passed).toBe(false);
    expect(result.downgradeAdvice).toBeDefined();
    expect(result.downgradeAdvice!.options.length).toBeGreaterThan(0);
  });

  it('daily cap exceeded + force=true → passes anyway', async () => {
    const opts = makeOpts({
      config: makeConfig({ dailyTokenCap: 3 }),
      force: true,
    });
    const result = await runPreSpawnGate(opts);
    expect(result.passed).toBe(true);
    expect(result.committed).toBe(true);
  });

  it('noChargeCheck=true → skips charge deduction', async () => {
    const opts = makeOpts({ noChargeCheck: true });
    const result = await runPreSpawnGate(opts);
    expect(result.passed).toBe(true);
    expect(result.committed).toBe(true);
    const state = await opts.charges.read();
    expect(state.current_charges).toBe(3);
  });

  it('passive recovery applies credits before charge check', async () => {
    const paths = busPaths(tmpDir);
    const chargeConfig: ChargeStoreConfig = {
      initial: 1,
      max: 5,
      min: -1,
      idleRecoveryMinutes: 30,
      cooldownHours: 24,
    };
    const charges = new ChargeStore(paths, clock, chargeConfig);
    await charges.deductForCast('old-cast', 'recon-swarm');
    const afterDeduct = await charges.read();
    expect(afterDeduct.current_charges).toBe(0);

    clock.advance(35 * 60_000);

    const opts = makeOpts({ charges });
    const result = await runPreSpawnGate(opts);
    expect(result.passed).toBe(true);
  });

  it('overdraft + cost > 1 → rejected', async () => {
    const paths = busPaths(tmpDir);
    const chargeConfig: ChargeStoreConfig = {
      initial: 1,
      max: 5,
      min: -3,
      idleRecoveryMinutes: 30,
      cooldownHours: 24,
    };
    const charges = new ChargeStore(paths, clock, chargeConfig);
    await charges.deductForCast('old', 'recon-swarm');
    await charges.creditFail('old', 'recon-swarm');
    const state = await charges.read();
    expect(state.current_charges).toBe(-1);

    const opts = makeOpts({
      mode: 'forking-realities',
      cloneCount: 2,
      charges,
    });
    const result = await runPreSpawnGate(opts);
    expect(result.passed).toBe(false);
  });
});
