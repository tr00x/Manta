import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';
import { addWorktree } from '../../src/spawner/worktree.js';
import {
  runCleanupCommand,
  formatCleanupResult,
  type ClaudeMcpExec,
} from '../../src/commands/cleanup.js';

let fx: RepoFixture | undefined;

afterEach(async () => {
  await fx?.cleanup();
  fx = undefined;
});

/** Spy `claude mcp …` runner: records argv, returns a canned result. */
function makeMcpExec(result: { exitCode?: number; timedOut?: boolean } = { exitCode: 0 }): {
  exec: ClaudeMcpExec;
  calls: string[][];
} {
  const calls: string[][] = [];
  const exec: ClaudeMcpExec = (args) => {
    calls.push(args);
    return Promise.resolve({
      exitCode: result.exitCode ?? 0,
      stdout: '',
      stderr: '',
      timedOut: result.timedOut ?? false,
    });
  };
  return { exec, calls };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('runCleanupCommand', () => {
  it('removes .manta worktrees + cast branches, deregisters bus, clears state (--yes)', async () => {
    fx = await makeRepoFixture('manta-cleanup-');
    const wt = await addWorktree({ repoRoot: fx.root, name: 'A', branch: 'manta/cast-test/A' });
    // A dangling manta/cast-* branch not attached to any worktree.
    await fx.run(['branch', 'manta/cast-old/Z']);
    // A non-Manta branch + worktree that MUST survive cleanup.
    await fx.run(['branch', 'feature/keepme']);

    expect(await exists(wt.path)).toBe(true);
    const stateDir = path.join(fx.root, '.manta', 'state');
    expect(await exists(stateDir)).toBe(true);

    const { exec, calls } = makeMcpExec({ exitCode: 0 });
    const result = await runCleanupCommand({ repoRoot: fx.root }, { mcpExec: exec });

    // Worktree dir gone.
    expect(await exists(wt.path)).toBe(false);
    expect(result.worktreesRemoved.some((p) => p.endsWith(path.join('.manta', 'worktrees', 'A')) || p.includes('worktrees'))).toBe(true);
    // Both the worktree branch and the dangling branch deleted.
    expect(result.branchesDeleted).toContain('manta/cast-test/A');
    expect(result.branchesDeleted).toContain('manta/cast-old/Z');
    const branches = (await fx.run(['branch', '--format=%(refname:short)'])).stdout;
    expect(branches).not.toContain('manta/cast-test/A');
    expect(branches).not.toContain('manta/cast-old/Z');
    // Non-Manta branch survived.
    expect(branches).toContain('feature/keepme');
    // Bus deregistered via the symmetric `claude mcp remove -s user manta-bus`.
    expect(result.busDeregistered).toBe('deregistered');
    expect(calls).toContainEqual(['mcp', 'remove', '-s', 'user', 'manta-bus']);
    // State cleared.
    expect(result.stateCleared).toBe(true);
    expect(await exists(stateDir)).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it('is idempotent — a second run is a clean no-op', async () => {
    fx = await makeRepoFixture('manta-cleanup-idem-');
    await addWorktree({ repoRoot: fx.root, name: 'A', branch: 'manta/cast-test/A' });

    const { exec } = makeMcpExec({ exitCode: 0 });
    await runCleanupCommand({ repoRoot: fx.root }, { mcpExec: exec });

    // Second run: nothing left.
    const { exec: exec2 } = makeMcpExec({ exitCode: 1 }); // remove now exits non-zero (not registered)
    const second = await runCleanupCommand({ repoRoot: fx.root }, { mcpExec: exec2 });
    expect(second.worktreesRemoved).toEqual([]);
    expect(second.branchesDeleted).toEqual([]);
    expect(second.stateCleared).toBe(false);
    expect(second.busDeregistered).toBe('not-registered');
    expect(second.warnings).toEqual([]);
  });

  it('--dry-run mutates nothing and never spawns claude', async () => {
    fx = await makeRepoFixture('manta-cleanup-dry-');
    const wt = await addWorktree({ repoRoot: fx.root, name: 'A', branch: 'manta/cast-test/A' });
    const stateDir = path.join(fx.root, '.manta', 'state');

    const { exec, calls } = makeMcpExec({ exitCode: 0 });
    const result = await runCleanupCommand({ repoRoot: fx.root }, { dryRun: true, mcpExec: exec });

    // Everything still on disk.
    expect(await exists(wt.path)).toBe(true);
    expect(await exists(stateDir)).toBe(true);
    const branches = (await fx.run(['branch', '--format=%(refname:short)'])).stdout;
    expect(branches).toContain('manta/cast-test/A');
    // Plan still enumerates the targets.
    expect(result.dryRun).toBe(true);
    expect(result.worktreesRemoved.length).toBe(1);
    expect(result.branchesDeleted).toContain('manta/cast-test/A');
    expect(result.busDeregistered).toBe('would-deregister');
    expect(result.stateCleared).toBe(true); // "would clear" — it exists
    // Dry-run is side-effect-free: claude is never invoked.
    expect(calls).toEqual([]);
    // Formatter labels it as a dry run.
    expect(formatCleanupResult(result)).toContain('dry run');
    expect(formatCleanupResult(result)).toContain('manta cleanup --yes');
  });

  it('tolerates a missing claude binary (mcpExec throws) as a warning, not a failure', async () => {
    fx = await makeRepoFixture('manta-cleanup-noclaude-');
    const failingExec: ClaudeMcpExec = () => Promise.reject(new Error('spawn claude ENOENT'));
    const result = await runCleanupCommand({ repoRoot: fx.root }, { mcpExec: failingExec });
    expect(result.busDeregistered).toBe('skipped-no-claude');
    expect(result.warnings.some((w) => w.includes('claude'))).toBe(true);
    // Everything else still completed.
    expect(result.stateCleared).toBe(true);
  });

  it('handles a repo with no .manta footprint at all', async () => {
    fx = await makeRepoFixture('manta-cleanup-empty-');
    // Remove the fixture's pre-seeded .manta/state so there is truly nothing.
    await fs.rm(path.join(fx.root, '.manta'), { recursive: true, force: true });
    const { exec } = makeMcpExec({ exitCode: 1 });
    const result = await runCleanupCommand({ repoRoot: fx.root }, { mcpExec: exec });
    expect(result.worktreesRemoved).toEqual([]);
    expect(result.branchesDeleted).toEqual([]);
    expect(result.stateCleared).toBe(false);
    expect(result.busDeregistered).toBe('not-registered');
    expect(result.warnings).toEqual([]);
  });
});
