import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { runLimitCommand } from '../../src/commands/limit.js';
import { createReporter, MemorySink } from '../../src/output/reporter.js';
import { createRuntime } from '../../src/runtime.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';

// Budget strip (2026-06-01): the only configurable limit is max_parallel_clones
// (Claude Code is subscription-based; charges/cooldown/token-cap were removed).
describe('limit command', () => {
  let fx: RepoFixture | undefined;
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  it('get shows defaults when no config file exists', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    const sink = new MemorySink();
    const result = await runLimitCommand(rt, {
      subcommand: 'get',
      reporter: createReporter({ sink }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('max_parallel_clones:');
    expect(result.stdout).toContain('5');
  });

  it('get with specific key returns value', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    const sink = new MemorySink();
    const result = await runLimitCommand(rt, {
      subcommand: 'get',
      key: 'max_parallel_clones',
      reporter: createReporter({ sink }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('max_parallel_clones: 5');
  });

  it('get with unknown key returns error', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    const sink = new MemorySink();
    const result = await runLimitCommand(rt, {
      subcommand: 'get',
      key: 'nonexistent_key',
      reporter: createReporter({ sink }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Unknown key');
  });

  it('set creates config file and updates value', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    const sink = new MemorySink();
    const result = await runLimitCommand(rt, {
      subcommand: 'set',
      key: 'max_parallel_clones',
      value: '3',
      reporter: createReporter({ sink }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('5 → 3');

    const configPath = path.join(fx.root, '.manta', 'config', 'budget.json');
    const raw = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.max_parallel_clones).toBe(3);
  });

  it('set with unknown key returns error', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    const sink = new MemorySink();
    const result = await runLimitCommand(rt, {
      subcommand: 'set',
      key: 'nonexistent',
      value: '42',
      reporter: createReporter({ sink }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Unknown key');
  });

  it('set creates .manta/config/ directory if needed', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    const sink = new MemorySink();
    await runLimitCommand(rt, {
      subcommand: 'set',
      key: 'max_parallel_clones',
      value: '2',
      reporter: createReporter({ sink }),
    });
    const configPath = path.join(fx.root, '.manta', 'config', 'budget.json');
    const stat = await fs.stat(configPath);
    expect(stat.isFile()).toBe(true);
  });
});
