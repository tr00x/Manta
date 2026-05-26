import { describe, it, expect, afterEach } from 'vitest';
import { runChargesCommand } from '../../src/commands/charges.js';
import { createReporter, MemorySink } from '../../src/output/reporter.js';
import { createRuntime } from '../../src/runtime.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';

describe('charges command', () => {
  let fx: RepoFixture | undefined;
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  it('shows nominal state with default charges', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    const sink = new MemorySink();
    const result = await runChargesCommand(rt, {
      reporter: createReporter({ sink }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Charges: 3 / 5');
    expect(result.stdout).toContain('State: nominal');
    expect(result.stdout).toContain('Mode availability:');
    expect(result.stdout).toContain('recon-swarm (1)');
    expect(result.stdout).toContain('✓');
  });

  it('shows overdraft state with restricted modes', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });

    await rt.ctx.charges.deductForCast('c1', 'recon-swarm');
    await rt.ctx.charges.deductForCast('c2', 'recon-swarm');
    await rt.ctx.charges.deductForCast('c3', 'recon-swarm');
    await rt.ctx.charges.creditFail('c3', 'recon-swarm');

    const sink = new MemorySink();
    const result = await runChargesCommand(rt, {
      reporter: createReporter({ sink }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('OVERDRAFT');
    expect(result.stdout).toContain('cost-1 modes');
    expect(result.stdout).toMatch(/forking-realities \(2\)\s+✗/);
  });

  it('shows cooldown state', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });

    await rt.ctx.charges.triggerCooldown();

    const sink = new MemorySink();
    const result = await runChargesCommand(rt, {
      reporter: createReporter({ sink }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('COOLDOWN');
    expect(result.stdout).toContain('manta refresh');
  });

  it('lists all modes with availability indicators', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    const sink = new MemorySink();
    const result = await runChargesCommand(rt, {
      reporter: createReporter({ sink }),
    });
    expect(result.stdout).toContain('recon-swarm');
    expect(result.stdout).toContain('forking-realities');
    expect(result.stdout).toContain('council');
    expect(result.stdout).toContain('phantom-lance');
  });
});
