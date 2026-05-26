import { describe, it, expect, afterEach } from 'vitest';
import { runCostCommand } from '../../src/commands/cost.js';
import { createReporter, MemorySink } from '../../src/output/reporter.js';
import { createRuntime } from '../../src/runtime.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';

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
    expect(result.stdout).toContain('$0.00 / $50.00');
    expect(result.stdout).toContain('Charges:');
  });

  it('shows daily entries after recording a cast', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });

    await rt.ctx.dailySpend.recordCastStart({
      cast_id: 'cast-test-1',
      mode: 'recon-swarm',
      clone_count: 3,
      estimated_cost_usd: 4.5,
      cost_type: 'estimate',
    });

    const sink = new MemorySink();
    const result = await runCostCommand(rt, {
      period: 'today',
      reporter: createReporter({ sink }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('$4.50');
    expect(result.stdout).toContain('cast-test-1');
    expect(result.stdout).toContain("Today's casts:");
    expect(result.stdout).toContain('Remaining today: $45.50');
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
