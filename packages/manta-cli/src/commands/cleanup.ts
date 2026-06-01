import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execa } from 'execa';
import { busPaths } from '@manta/bus';
import { listWorktrees, removeWorktree } from '../spawner/worktree.js';
import type { ClaudeMcpResult } from './mcp-preflight.js';

/**
 * `manta cleanup` — tear Manta itself out of a repo.
 *
 * `manta uninstall` only removes a Library *package*. After a user removes the
 * Manta plugin, the per-repo footprint is left behind: `.manta/worktrees/*`
 * (each a real git worktree on a `manta/cast-*` branch), any dangling
 * `manta/cast-*` branches, the `manta-bus` MCP registration, and `.manta/state`
 * (registry, locks, events). This command removes all of it.
 *
 * Idempotent: a second run is a no-op (nothing left to remove). Dry-runnable:
 * `dryRun` computes the plan and mutates nothing — and (like `install
 * --dry-run`) never spawns `claude`, so it works from any cwd even without the
 * CLI on PATH.
 */

/** Injection seam for `claude mcp …` — mirrors bootstrap.ts. */
export type ClaudeMcpExec = (args: string[]) => Promise<ClaudeMcpResult>;

/** Injection seam for git operations so tests need no real worktrees. */
export interface CleanupGitOps {
  listWorktrees(opts: { repoRoot: string }): Promise<Array<{ path: string; branch: string }>>;
  removeWorktree(opts: { repoRoot: string; worktreePath: string; branch: string }): Promise<void>;
  pruneWorktrees(opts: { repoRoot: string }): Promise<void>;
  listCastBranches(opts: { repoRoot: string }): Promise<string[]>;
  deleteBranch(opts: { repoRoot: string; branch: string }): Promise<void>;
}

export interface RunCleanupOptions {
  /** Compute the plan and mutate nothing. */
  dryRun?: boolean;
  /** Override the `claude mcp …` runner (tests inject a spy). */
  mcpExec?: ClaudeMcpExec;
  /** Override git operations (tests inject fakes). */
  git?: CleanupGitOps;
}

export type BusDeregisterOutcome =
  | 'deregistered'
  | 'not-registered'
  | 'skipped-no-claude'
  | 'would-deregister';

export interface RunCleanupResult {
  dryRun: boolean;
  /** Worktree paths under `.manta/worktrees/` removed (or, in dry-run, slated). */
  worktreesRemoved: string[];
  /** `manta/cast-*` branches deleted (or, in dry-run, slated). */
  branchesDeleted: string[];
  busDeregistered: BusDeregisterOutcome;
  /** Whether `.manta/state` was cleared (or, in dry-run, exists and would be). */
  stateCleared: boolean;
  /** Non-fatal problems (a worktree that wouldn't remove, etc.). */
  warnings: string[];
}

const BUS_MCP_TIMEOUT_MS = 15_000;
const BUS_SERVER_NAME = 'manta-bus';

const defaultMcpExec: ClaudeMcpExec = (args) =>
  /* c8 ignore next */
  execa('claude', args, { reject: false, timeout: BUS_MCP_TIMEOUT_MS });

const defaultGitOps: CleanupGitOps = {
  listWorktrees,
  removeWorktree,
  async pruneWorktrees({ repoRoot }) {
    await execa('git', ['worktree', 'prune'], { cwd: repoRoot });
  },
  async listCastBranches({ repoRoot }) {
    const r = await execa(
      'git',
      ['branch', '--list', 'manta/cast-*', '--format=%(refname:short)'],
      { cwd: repoRoot },
    );
    return r.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  },
  async deleteBranch({ repoRoot, branch }) {
    await execa('git', ['branch', '-D', branch], { cwd: repoRoot });
  },
};

async function safeRealpath(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return p;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Deregister the `manta-bus` MCP server (user scope) — the symmetric inverse of
 * `runBootstrap`'s `claude mcp add -s user manta-bus`. Tolerant: a missing
 * registration or a missing `claude` binary are non-fatal (cleanup is a
 * best-effort teardown, not a precondition-checked install).
 */
async function deregisterBus(
  exec: ClaudeMcpExec,
  dryRun: boolean,
  warnings: string[],
): Promise<BusDeregisterOutcome> {
  if (dryRun) return 'would-deregister';
  let result: ClaudeMcpResult;
  try {
    result = await exec(['mcp', 'remove', '-s', 'user', BUS_SERVER_NAME]);
  } catch {
    // `claude` not on PATH (or spawn failure) — teardown continues regardless.
    warnings.push(
      `could not run \`claude mcp remove ${BUS_SERVER_NAME}\` (is the claude CLI on PATH?); ` +
        `remove it manually with \`claude mcp remove -s user ${BUS_SERVER_NAME}\` if it lingers`,
    );
    return 'skipped-no-claude';
  }
  if (result.timedOut) {
    warnings.push(`\`claude mcp remove ${BUS_SERVER_NAME}\` timed out; remove it manually if it lingers`);
    return 'skipped-no-claude';
  }
  // `claude mcp remove` exits non-zero when the server was not registered —
  // that's the already-clean case for an idempotent teardown.
  return (result.exitCode ?? 1) === 0 ? 'deregistered' : 'not-registered';
}

export async function runCleanupCommand(
  rt: { repoRoot: string },
  opts: RunCleanupOptions = {},
): Promise<RunCleanupResult> {
  const dryRun = opts.dryRun ?? false;
  const exec = opts.mcpExec ?? defaultMcpExec;
  const git = opts.git ?? defaultGitOps;
  const warnings: string[] = [];

  // --- 1. Worktrees under .manta/worktrees/ ---------------------------------
  // prune first so worktrees whose dirs were deleted out-of-band don't block
  // enumeration. Non-fatal if prune itself fails.
  if (!dryRun) {
    try {
      await git.pruneWorktrees({ repoRoot: rt.repoRoot });
    } catch (err) {
      warnings.push(`git worktree prune failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const repoRootCanon = await safeRealpath(rt.repoRoot);
  const mantaPrefix = path.join(repoRootCanon, '.manta', 'worktrees') + path.sep;
  let allWorktrees: Array<{ path: string; branch: string }> = [];
  try {
    allWorktrees = await git.listWorktrees({ repoRoot: rt.repoRoot });
  } catch (err) {
    warnings.push(`could not list git worktrees: ${err instanceof Error ? err.message : String(err)}`);
  }
  const mantaWorktrees: Array<{ path: string; branch: string }> = [];
  for (const wt of allWorktrees) {
    const canon = await safeRealpath(wt.path);
    if (canon.startsWith(mantaPrefix)) mantaWorktrees.push(wt);
  }

  const worktreesRemoved: string[] = [];
  const branchesFreedByWorktree = new Set<string>();
  for (const wt of mantaWorktrees) {
    if (dryRun) {
      worktreesRemoved.push(wt.path);
      if (wt.branch !== '(detached)') branchesFreedByWorktree.add(wt.branch);
      continue;
    }
    try {
      await git.removeWorktree({ repoRoot: rt.repoRoot, worktreePath: wt.path, branch: wt.branch });
      worktreesRemoved.push(wt.path);
      if (wt.branch !== '(detached)') branchesFreedByWorktree.add(wt.branch);
    } catch (err) {
      warnings.push(
        `failed to remove worktree ${wt.path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // --- 2. Dangling manta/cast-* branches not attached to a worktree ---------
  let castBranches: string[] = [];
  try {
    castBranches = await git.listCastBranches({ repoRoot: rt.repoRoot });
  } catch (err) {
    warnings.push(`could not list manta/cast-* branches: ${err instanceof Error ? err.message : String(err)}`);
  }
  const branchesDeleted: string[] = [];
  // removeWorktree already deletes the branch attached to each worktree; only
  // delete the ones that survive (dangling) to avoid double-delete warnings.
  const dangling = castBranches.filter((b) => !branchesFreedByWorktree.has(b));
  // Report worktree-freed branches in the deleted set too (they ARE deleted),
  // but only actually issue git for the dangling remainder.
  for (const b of branchesFreedByWorktree) branchesDeleted.push(b);
  for (const branch of dangling) {
    if (dryRun) {
      branchesDeleted.push(branch);
      continue;
    }
    try {
      await git.deleteBranch({ repoRoot: rt.repoRoot, branch });
      branchesDeleted.push(branch);
    } catch (err) {
      warnings.push(
        `failed to delete branch ${branch}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // --- 3. Bus MCP deregistration --------------------------------------------
  const busDeregistered = await deregisterBus(exec, dryRun, warnings);

  // --- 4. Clear .manta/state -------------------------------------------------
  const stateDir = busPaths(rt.repoRoot).stateDir;
  const stateExists = await pathExists(stateDir);
  let stateCleared = false;
  if (stateExists) {
    if (dryRun) {
      stateCleared = true; // slated
    } else {
      try {
        await fs.rm(stateDir, { recursive: true, force: true });
        stateCleared = true;
      } catch (err) {
        warnings.push(`failed to clear ${stateDir}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return {
    dryRun,
    worktreesRemoved,
    branchesDeleted,
    busDeregistered,
    stateCleared,
    warnings,
  };
}

function describeBus(outcome: BusDeregisterOutcome): string {
  switch (outcome) {
    case 'deregistered':
      return 'deregistered the manta-bus MCP server (user scope)';
    case 'not-registered':
      return 'manta-bus MCP server was not registered (nothing to do)';
    case 'skipped-no-claude':
      return 'skipped manta-bus MCP deregistration (claude CLI unavailable — see warnings)';
    case 'would-deregister':
      return 'would deregister the manta-bus MCP server (user scope)';
  }
}

/** Render a {@link RunCleanupResult} as human-readable CLI output. */
export function formatCleanupResult(result: RunCleanupResult): string {
  const verb = result.dryRun ? 'Would remove' : 'Removed';
  const lines: string[] = [];
  lines.push(result.dryRun ? 'Manta cleanup — dry run (nothing was changed):' : 'Manta cleanup complete:');
  lines.push(`  ${verb} ${result.worktreesRemoved.length} worktree(s) under .manta/worktrees/`);
  for (const w of result.worktreesRemoved) lines.push(`    - ${w}`);
  lines.push(`  ${verb} ${result.branchesDeleted.length} manta/cast-* branch(es)`);
  for (const b of result.branchesDeleted) lines.push(`    - ${b}`);
  lines.push(`  ${describeBus(result.busDeregistered)}`);
  lines.push(
    result.stateCleared
      ? `  ${result.dryRun ? 'Would clear' : 'Cleared'} .manta/state`
      : '  .manta/state — not present (nothing to do)',
  );
  if (result.warnings.length > 0) {
    lines.push(`  ${result.warnings.length} warning(s):`);
    for (const w of result.warnings) lines.push(`    ! ${w}`);
  }
  if (result.dryRun) {
    lines.push('Re-run with `manta cleanup --yes` to execute.');
  }
  return lines.join('\n');
}
