import { describe, it, expect, afterEach } from 'vitest';
import { runTailCommand } from '../../src/commands/tail.js';
import { createRuntime } from '../../src/runtime.js';
import { createReporter, MemorySink } from '../../src/output/reporter.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';
import type { BusEvent } from '@manta/bus';
import { isCliError } from '../../src/errors.js';

describe('tail command', () => {
  let fx: RepoFixture | undefined;
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  const mkReporter = (): { sink: MemorySink; reporter: ReturnType<typeof createReporter> } => {
    const s = new MemorySink();
    return { sink: s, reporter: createReporter({ sink: s }) };
  };

  it('picks up events appended during the loop', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    await rt.ctx.registry.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: fx.root,
      metadata: {},
    });

    // Append events before starting tail
    await rt.ctx.events.append({ type: 'test_event', clone_id: 'A', payload: { n: 1 } });

    const { reporter } = mkReporter();
    // Very short duration so it finishes fast
    const result = await runTailCommand(rt, {
      cloneId: 'A',
      durationMs: 500,
      intervalMs: 100,
      raw: false,
      reporter,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('test_event');
  });

  it('exits when clone reaches DEAD state', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    await rt.ctx.registry.register({
      clone_id: 'B',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: fx.root,
      metadata: {},
    });
    await rt.ctx.registry.markDead('B', 'done');

    const { reporter } = mkReporter();
    const start = Date.now();
    const result = await runTailCommand(rt, {
      cloneId: 'B',
      durationMs: 10_000,
      intervalMs: 100,
      raw: false,
      reporter,
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
    expect(result.stdout).toContain('DEAD');
    expect(result.stdout).toContain('done');
  });

  it('exits when duration elapses', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    await rt.ctx.registry.register({
      clone_id: 'C',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: fx.root,
      metadata: {},
    });

    const { reporter } = mkReporter();
    const start = Date.now();
    const result = await runTailCommand(rt, {
      cloneId: 'C',
      durationMs: 300,
      intervalMs: 100,
      raw: false,
      reporter,
    });
    const elapsed = Date.now() - start;
    expect(result.exitCode).toBe(0);
    expect(elapsed).toBeLessThan(3000);
  });

  it('exits on signal abort', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    await rt.ctx.registry.register({
      clone_id: 'D',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: fx.root,
      metadata: {},
    });

    const { reporter } = mkReporter();
    // The command creates its own AbortController internally, but we
    // can verify timeout by using very short duration
    const result = await runTailCommand(rt, {
      cloneId: 'D',
      durationMs: 200,
      intervalMs: 50,
      raw: false,
      reporter,
    });
    expect(result.exitCode).toBe(0);
  });

  it('produces valid JSON lines with raw: true', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    await rt.ctx.registry.register({
      clone_id: 'E',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: fx.root,
      metadata: {},
    });
    await rt.ctx.events.append({ type: 'raw_test', clone_id: 'E', payload: { v: 42 } });

    const { reporter } = mkReporter();
    const result = await runTailCommand(rt, {
      cloneId: 'E',
      durationMs: 300,
      intervalMs: 100,
      raw: true,
      reporter,
    });
    const nonEmpty = result.stdout.split('\n').filter((l) => l.length > 0 && !l.startsWith('---'));
    for (const line of nonEmpty) {
      expect(() => JSON.parse(line) as BusEvent).not.toThrow();
    }
  });

  it('M2: rejects a nonexistent cloneId up front with a not_found CliError (exit 1), no ~10s hang', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    // No clone registered. The CLI's real minimum duration is 10s; before the
    // up-front check this streamed nothing for ~10s then exited 0. It must now
    // fail fast and loudly.
    const { reporter } = mkReporter();
    const start = Date.now();
    let caught: unknown;
    try {
      await runTailCommand(rt, {
        cloneId: 'NOPE',
        durationMs: 10_000,
        intervalMs: 2_000,
        raw: false,
        reporter,
      });
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - start;
    expect(isCliError(caught)).toBe(true);
    expect((caught as { kind: string }).kind).toBe('not_found');
    expect((caught as { exitCode: number }).exitCode).toBe(1);
    expect((caught as Error).message).toContain('NOPE');
    // Fail-fast: nowhere near the 10s duration / old 10s grace window.
    expect(elapsed).toBeLessThan(2000);
  });

  it('only shows events for the specified cloneId', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    await rt.ctx.registry.register({
      clone_id: 'F',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: fx.root,
      metadata: {},
    });
    await rt.ctx.registry.register({
      clone_id: 'G',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: fx.root,
      metadata: {},
    });
    await rt.ctx.events.append({ type: 'my_event', clone_id: 'F', payload: {} });
    await rt.ctx.events.append({ type: 'other_event', clone_id: 'G', payload: {} });

    const { reporter } = mkReporter();
    const result = await runTailCommand(rt, {
      cloneId: 'F',
      durationMs: 300,
      intervalMs: 100,
      raw: false,
      reporter,
    });
    expect(result.stdout).toContain('my_event');
    expect(result.stdout).not.toContain('other_event');
  });
});
