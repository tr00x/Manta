import { describe, it, expect, afterEach } from 'vitest';
import { runKillCommand } from '../../src/commands/kill.js';
import { createReporter, MemorySink } from '../../src/output/reporter.js';
import { createRuntime } from '../../src/runtime.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';

describe('kill command', () => {
  let fx: RepoFixture | undefined;
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  it('marks the clone DEAD and writes a post-mortem', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    await rt.ctx.registry.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: fx.root,
      metadata: { cast_id: 'cast-k' },
    });
    const sink = new MemorySink();
    const result = await runKillCommand(rt, {
      cloneId: 'A',
      reason: 'manual',
      reporter: createReporter({ sink }),
    });
    expect(result.exitCode).toBe(0);
    const r = await rt.ctx.registry.get('A');
    expect(r.state).toBe('DEAD');
    // Phase-0 post-mortem stamps the reason verbatim into death_reason.
    expect(r.death_reason).toContain('manual');
    // Reporter logged a `kill` event.
    expect(sink.lines.map((l) => l.event)).toContain('kill');
  });

  it('throws CliError(not_found) for unknown clone', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    await expect(
      runKillCommand(rt, {
        cloneId: 'GHOST',
        reason: 'manual',
        reporter: createReporter({ sink: new MemorySink() }),
      }),
    ).rejects.toMatchObject({ name: 'CliError', kind: 'not_found' });
  });

  it("SIGTERM→SIGKILLs ONLY the clone's own pid (never the parent group) before markDead (#65)", async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    await rt.ctx.registry.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 4242,
      worktree: fx.root,
      metadata: { cast_id: 'cast-k' },
    });
    await rt.ctx.registry.recordClonePid('A', 9001);

    const order: string[] = [];
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const kill = (pid: number, signal: NodeJS.Signals) => {
      signals.push({ pid, signal });
      order.push(`kill:${signal}:${pid}`);
    };
    const reg = rt.ctx.registry as unknown as {
      markDead: (...args: unknown[]) => Promise<unknown>;
    };
    const origMarkDead = reg.markDead.bind(rt.ctx.registry);
    reg.markDead = async (...args: unknown[]) => {
      order.push(`markDead:${String(args[0])}`);
      return origMarkDead(...args);
    };

    await runKillCommand(rt, {
      cloneId: 'A',
      reason: 'manual',
      reporter: createReporter({ sink: new MemorySink() }),
      kill,
      sleep: async () => {},
      gracefulMs: 0,
      isAlive: () => true,
    });

    // ONLY the clone's own pid 9001 (bare, positive) — never the parent group
    // (-4242) — so killing one clone never reaps a sibling or a running cast.
    expect(signals).toEqual([
      { pid: 9001, signal: 'SIGTERM' },
      { pid: 9001, signal: 'SIGKILL' },
    ]);
    // Every signal preceded markDead (never DEAD while the process runs).
    const lastKill = order.map((s) => s.startsWith('kill:')).lastIndexOf(true);
    const firstMarkDead = order.findIndex((s) => s.startsWith('markDead:'));
    expect(lastKill).toBeGreaterThanOrEqual(0);
    expect(firstMarkDead).toBeGreaterThan(lastKill);
    expect((await rt.ctx.registry.get('A')).state).toBe('DEAD');
  });

  it('no-ops the OS signal when the clone has no recorded pid (legacy / killed pre-launch)', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    await rt.ctx.registry.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 4242,
      worktree: fx.root,
      metadata: { cast_id: 'cast-k' },
    });
    // No recordClonePid → clone_pid is undefined.
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const result = await runKillCommand(rt, {
      cloneId: 'A',
      reason: 'manual',
      reporter: createReporter({ sink: new MemorySink() }),
      kill: (pid: number, signal: NodeJS.Signals) => signals.push({ pid, signal }),
      sleep: async () => {},
      gracefulMs: 0,
    });
    expect(signals).toHaveLength(0); // nothing to signal — but still…
    expect(result.exitCode).toBe(0);
    expect((await rt.ctx.registry.get('A')).state).toBe('DEAD'); // …marked DEAD
  });
});
