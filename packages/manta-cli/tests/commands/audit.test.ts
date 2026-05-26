import { describe, it, expect, afterEach } from 'vitest';
import { runAuditCommand } from '../../src/commands/audit.js';
import { createRuntime } from '../../src/runtime.js';
import { createReporter, MemorySink } from '../../src/output/reporter.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';
import { CliError } from '../../src/errors.js';

describe('audit command', () => {
  let fx: RepoFixture | undefined;
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  const sink = (): { sink: MemorySink; reporter: ReturnType<typeof createReporter> } => {
    const s = new MemorySink();
    return { sink: s, reporter: createReporter({ sink: s }) };
  };

  async function seedClone(rt: Awaited<ReturnType<typeof createRuntime>>): Promise<void> {
    await rt.ctx.registry.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: '/tmp/wt',
      metadata: { cast_id: 'cast-1' },
    });
    await rt.ctx.events.append({ type: 'register', clone_id: 'A', payload: {} });
    await rt.ctx.events.append({ type: 'heartbeat', clone_id: 'A', payload: { state: 'WORKING' } });
    await rt.ctx.events.append({ type: 'lock', clone_id: 'A', payload: { resource: 'file.ts' } });
    await rt.ctx.events.append({ type: 'broadcast', clone_id: 'A', payload: { msg: 'done' } });
  }

  it('returns markdown audit for a valid cloneId', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    await seedClone(rt);
    const { reporter } = sink();
    const result = await runAuditCommand(rt, {
      cloneId: 'A',
      format: 'markdown',
      reporter,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Audit — clone A');
    expect(result.stdout).toContain('recon-swarm');
  });

  it('returns valid JSON with --format json', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    await seedClone(rt);
    const { reporter } = sink();
    const result = await runAuditCommand(rt, {
      cloneId: 'A',
      format: 'json',
      reporter,
    });
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed).toHaveProperty('cloneId', 'A');
    expect(parsed).toHaveProperty('entries');
    expect(parsed).toHaveProperty('stats');
  });

  it('filters by --type', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    await seedClone(rt);
    const { reporter } = sink();
    const result = await runAuditCommand(rt, {
      cloneId: 'A',
      format: 'json',
      typeFilter: ['lifecycle'],
      reporter,
    });
    const parsed = JSON.parse(result.stdout) as { entries: Array<{ event: { type: string } }> };
    for (const entry of parsed.entries) {
      expect(['register', 'heartbeat', 'suicide_intent', 'death']).toContain(entry.event.type);
    }
  });

  it('filters by --since', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    await seedClone(rt);
    const { reporter } = sink();
    const result = await runAuditCommand(rt, {
      cloneId: 'A',
      format: 'json',
      since: Date.now() + 999_999,
      reporter,
    });
    const parsed = JSON.parse(result.stdout) as { entries: unknown[] };
    expect(parsed.entries.length).toBe(0);
  });

  it('respects --limit', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    await seedClone(rt);
    const { reporter } = sink();
    const result = await runAuditCommand(rt, {
      cloneId: 'A',
      format: 'json',
      limit: 2,
      reporter,
    });
    const parsed = JSON.parse(result.stdout) as { entries: unknown[] };
    expect(parsed.entries.length).toBe(2);
  });

  it('detects gap anomalies with --gaps', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    await seedClone(rt);
    const { reporter } = sink();
    const result = await runAuditCommand(rt, {
      cloneId: 'A',
      format: 'markdown',
      gaps: true,
      gapThreshold: 1,
      reporter,
    });
    expect(result.exitCode).toBe(0);
  });

  it('throws CliError not_found for missing cloneId', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    const { reporter } = sink();
    await expect(
      runAuditCommand(rt, { cloneId: 'ghost', format: 'markdown', reporter }),
    ).rejects.toThrow(CliError);
    try {
      await runAuditCommand(rt, { cloneId: 'ghost', format: 'markdown', reporter });
    } catch (err) {
      expect((err as CliError).kind).toBe('not_found');
    }
  });
});
