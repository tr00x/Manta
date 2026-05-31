import { describe, it, expect, afterEach } from 'vitest';
import { runCostCommand, normalizeCostPeriod } from '../../src/commands/cost.js';
import { createReporter, MemorySink } from '../../src/output/reporter.js';
import { createRuntime } from '../../src/runtime.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';
import { isCliError } from '../../src/errors.js';

describe('cost command', () => {
  let fx: RepoFixture | undefined;
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  it('shows "No casts today" when ledger is empty', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    const sink = new MemorySink();
    const result = await runCostCommand(rt, {
      period: 'today',
      reporter: createReporter({ sink }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No casts today');
    expect(result.stdout).toContain('Usage today: 0 casts, 0 clones spawned');
    expect(result.stdout).toContain('Token estimate today:');
    expect(result.stdout).toContain('Charges:');
  });

  it('shows daily entries after recording a cast', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });

    await rt.ctx.dailySpend.recordCastStart({
      cast_id: 'cast-test-1',
      mode: 'recon-swarm',
      clone_count: 3,
      estimated_tokens: 150_000,
      estimate_type: 'estimate',
    });

    const sink = new MemorySink();
    const result = await runCostCommand(rt, {
      period: 'today',
      reporter: createReporter({ sink }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('cast-test-1');
    expect(result.stdout).toContain("Today's casts:");
    expect(result.stdout).toContain('Usage today: 1 cast, 3 clones spawned');
    // Token estimate (subscription usage proxy, not dollars) is rendered compactly.
    expect(result.stdout).toContain('150k tok');
    expect(result.stdout).toContain('Token estimate today:');
  });

  it('shows weekly summary', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    const sink = new MemorySink();
    const result = await runCostCommand(rt, {
      period: 'week',
      reporter: createReporter({ sink }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('This week:');
    expect(result.stdout).toContain('Avg:');
  });

  it('M3: daily and weekly produce distinct reports (the period arg is honoured)', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    await rt.ctx.dailySpend.recordCastStart({
      cast_id: 'cast-period-1',
      mode: 'recon-swarm',
      clone_count: 2,
      estimated_tokens: 120_000,
      estimate_type: 'estimate',
    });

    const daily = await runCostCommand(rt, {
      period: 'today',
      reporter: createReporter({ sink: new MemorySink() }),
    });
    const weekly = await runCostCommand(rt, {
      period: 'week',
      reporter: createReporter({ sink: new MemorySink() }),
    });

    // Daily report is the "Usage today / Today's casts" view; weekly is the
    // 7-day "This week / Avg" view. They must NOT be identical (the M3 bug made
    // `weekly` collapse to the daily output).
    expect(daily.stdout).toContain('Usage today:');
    expect(daily.stdout).toContain("Today's casts:");
    expect(weekly.stdout).toContain('This week:');
    expect(weekly.stdout).toContain('Avg:');
    expect(weekly.stdout).not.toContain("Today's casts:");
    expect(daily.stdout).not.toBe(weekly.stdout);
  });

  describe('M3: normalizeCostPeriod', () => {
    it('maps daily spellings (incl. undefined default) to "today"', () => {
      expect(normalizeCostPeriod(undefined)).toBe('today');
      expect(normalizeCostPeriod('today')).toBe('today');
      expect(normalizeCostPeriod('day')).toBe('today');
      expect(normalizeCostPeriod('daily')).toBe('today');
      expect(normalizeCostPeriod('  TODAY ')).toBe('today');
    });

    it('maps "week" AND "weekly" to "week" (M3: "weekly" no longer silently falls to daily)', () => {
      expect(normalizeCostPeriod('week')).toBe('week');
      expect(normalizeCostPeriod('weekly')).toBe('week');
      expect(normalizeCostPeriod('  Weekly ')).toBe('week');
    });

    it('rejects an unknown period with an invalid_input CliError (exit 1) instead of defaulting to daily', () => {
      let caught: unknown;
      try {
        normalizeCostPeriod('month');
      } catch (err) {
        caught = err;
      }
      expect(isCliError(caught)).toBe(true);
      expect((caught as { kind: string }).kind).toBe('invalid_input');
      expect((caught as { exitCode: number }).exitCode).toBe(1);
      expect((caught as Error).message).toContain('month');
    });
  });

  it('includes charges display', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    const sink = new MemorySink();
    const result = await runCostCommand(rt, {
      reporter: createReporter({ sink }),
    });
    expect(result.stdout).toMatch(/Charges: \d+\/\d+/);
  });
});
