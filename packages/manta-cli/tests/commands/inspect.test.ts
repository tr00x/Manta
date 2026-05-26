import { describe, it, expect, afterEach } from 'vitest';
import { runInspectCommand } from '../../src/commands/inspect.js';
import { createRuntime } from '../../src/runtime.js';
import { createReporter, MemorySink } from '../../src/output/reporter.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';
import { CliError } from '../../src/errors.js';

describe('inspect command', () => {
  let fx: RepoFixture | undefined;
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  const sink = (): { sink: MemorySink; reporter: ReturnType<typeof createReporter> } => {
    const s = new MemorySink();
    return { sink: s, reporter: createReporter({ sink: s }) };
  };

  it('returns clone details for a valid cloneId', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    await rt.ctx.registry.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: fx.root,
      metadata: {},
    });
    const { reporter } = sink();
    const result = await runInspectCommand(rt, {
      cloneId: 'A',
      json: false,
      eventCount: 10,
      reporter,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Clone A');
    expect(result.stdout).toContain('recon-swarm');
    expect(result.stdout).toContain('STARTING');
  });

  it('returns valid JSON with --json', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    await rt.ctx.registry.register({
      clone_id: 'B',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: fx.root,
      metadata: {},
    });
    const { reporter } = sink();
    const result = await runInspectCommand(rt, {
      cloneId: 'B',
      json: true,
      eventCount: 10,
      reporter,
    });
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed).toHaveProperty('clone');
    expect(parsed).toHaveProperty('contract');
    expect(parsed).toHaveProperty('locks');
    expect(parsed).toHaveProperty('claims');
    expect(parsed).toHaveProperty('recentEvents');
    expect(parsed).toHaveProperty('liveness');
  });

  it('throws CliError not_found for missing cloneId', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    const { reporter } = sink();
    await expect(
      runInspectCommand(rt, { cloneId: 'ghost', json: false, eventCount: 10, reporter }),
    ).rejects.toThrow(CliError);
    try {
      await runInspectCommand(rt, { cloneId: 'ghost', json: false, eventCount: 10, reporter });
    } catch (err) {
      expect((err as CliError).kind).toBe('not_found');
    }
  });

  it('shows DEAD state and death_reason', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    await rt.ctx.registry.register({
      clone_id: 'C',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: fx.root,
      metadata: {},
    });
    await rt.ctx.registry.markDead('C', 'budget_exceeded');
    const { reporter } = sink();
    const result = await runInspectCommand(rt, {
      cloneId: 'C',
      json: false,
      eventCount: 10,
      reporter,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('DEAD');
    expect(result.stdout).toContain('budget_exceeded');
  });

  it('shows "(not yet written)" for clone with no contract', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    await rt.ctx.registry.register({
      clone_id: 'D',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: fx.root,
      metadata: {},
    });
    const { reporter } = sink();
    const result = await runInspectCommand(rt, {
      cloneId: 'D',
      json: false,
      eventCount: 10,
      reporter,
    });
    expect(result.stdout).toContain('(not yet written)');
  });

  it('respects eventCount limit', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    await rt.ctx.registry.register({
      clone_id: 'E',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: fx.root,
      metadata: {},
    });
    for (let i = 0; i < 10; i++) {
      await rt.ctx.events.append({ type: 'test_event', clone_id: 'E', payload: { i } });
    }
    const { reporter } = sink();
    const result = await runInspectCommand(rt, {
      cloneId: 'E',
      json: true,
      eventCount: 3,
      reporter,
    });
    const parsed = JSON.parse(result.stdout) as { recentEvents: unknown[] };
    expect(parsed.recentEvents.length).toBe(3);
  });
});
