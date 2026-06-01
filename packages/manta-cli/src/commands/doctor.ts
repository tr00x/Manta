import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execa } from 'execa';

import type { CommandResult } from './status.js';
import {
  MANTA_BUS_CANDIDATE_NAMES,
  type ClaudeMcpRunner,
  type ClaudeMcpResult,
} from './mcp-preflight.js';
import { getMantaCliVersion } from '../library/cli-version.js';

/**
 * `manta doctor` — a read-only environment health check. It NEVER throws and
 * always exits 0: it is a diagnostic, so "some checks fail" is a valid result
 * the operator reads, not an error. The whole point is to run when the
 * environment is broken (no `claude` on PATH, not a git repo, bus unregistered)
 * — so unlike every other command it does NOT go through `createRuntime`, which
 * refuses to run outside a git checkout. Each probe is injectable for tests.
 */

/** Minimum Node major the CLI supports (mirrors package.json `engines.node`). */
export const MIN_NODE_MAJOR = 20;

export interface DoctorCheck {
  /** Short label printed before the ✓/✗. */
  label: string;
  /** True = healthy (✓), false = problem (✗). */
  ok: boolean;
  /** Value or, on failure, an actionable next step. */
  detail: string;
}

/**
 * Injection seam. Production wires real probes (execa, fs, the bus store);
 * tests pass deterministic stubs so they never touch a real `claude` binary,
 * the filesystem, or a registered MCP server.
 */
export interface DoctorProbes {
  /** The directory being diagnosed (defaults to process.cwd()). */
  cwd: string;
  /** Running Node version string, e.g. `v20.11.0`. */
  nodeVersion: () => string;
  /** Resolves true if a `claude` binary is invocable on PATH. */
  claudeOnPath: () => Promise<boolean>;
  /** Probes one MCP server by name (reuses the preflight candidate-name set). */
  busRunner: ClaudeMcpRunner;
  /** Resolves true if `cwd` is inside a git repo. */
  isGitRepo: (cwd: string) => Promise<boolean>;
  /** The installed manta version. */
  mantaVersion: () => string;
}

export interface DoctorCommandOptions {
  /** Partial probe overrides; anything omitted uses the production default. */
  probes?: Partial<DoctorProbes>;
}

function parseNodeMajor(version: string): number {
  // version is like `v20.11.0`; tolerate a missing leading `v`.
  const m = /^v?(\d+)\./.exec(version.trim());
  return m && m[1] !== undefined ? Number.parseInt(m[1], 10) : NaN;
}

const defaultBusRunner: ClaudeMcpRunner = (serverName: string): Promise<ClaudeMcpResult> =>
  execa('claude', ['mcp', 'get', serverName], { reject: false, timeout: 15_000 });

async function defaultClaudeOnPath(): Promise<boolean> {
  try {
    const r = await execa('claude', ['--version'], { reject: false, timeout: 15_000 });
    return r.exitCode === 0;
  } catch {
    // ENOENT (not on PATH) or any spawn failure → not available.
    return false;
  }
}

async function defaultIsGitRepo(cwd: string): Promise<boolean> {
  // Walk up to the filesystem root looking for a `.git` entry, matching how the
  // CLI runtime anchors a repo (a `.git` file is valid too — worktrees use one).
  let dir = path.resolve(cwd);
  for (;;) {
    try {
      await fs.access(path.join(dir, '.git'));
      return true;
    } catch {
      // not here — climb
    }
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Probe whether the manta-bus MCP server is registered under ANY of the
 * candidate names (bare `manta-bus` or the plugin-namespaced
 * `plugin:manta:manta-bus`). Non-throwing — unlike the cast preflight, doctor
 * reports the result rather than aborting.
 */
async function probeBus(
  runner: ClaudeMcpRunner,
): Promise<{ ok: boolean; detail: string }> {
  for (const name of MANTA_BUS_CANDIDATE_NAMES) {
    let result: ClaudeMcpResult;
    try {
      result = await runner(name);
    } catch {
      return {
        ok: false,
        detail: 'cannot run `claude mcp get` — is the claude CLI on PATH?',
      };
    }
    if (result.timedOut) {
      continue;
    }
    if (result.exitCode === 0 && result.stdout.includes('manta-bus')) {
      return { ok: true, detail: `registered as \`${name}\`` };
    }
  }
  return {
    ok: false,
    detail:
      'not registered — install the Manta plugin (auto-registers the bus) or run `manta install`',
  };
}

/**
 * Run the full health check and return formatted output. Always exits 0.
 */
export async function runDoctorCommand(opts: DoctorCommandOptions = {}): Promise<CommandResult> {
  const o = opts.probes ?? {};
  const cwd = o.cwd ?? process.cwd();
  const probes: DoctorProbes = {
    cwd,
    nodeVersion: o.nodeVersion ?? (() => process.version),
    claudeOnPath: o.claudeOnPath ?? defaultClaudeOnPath,
    busRunner: o.busRunner ?? defaultBusRunner,
    isGitRepo: o.isGitRepo ?? defaultIsGitRepo,
    mantaVersion: o.mantaVersion ?? getMantaCliVersion,
  };

  const checks: DoctorCheck[] = [];

  // 1. Node version
  const nodeVer = probes.nodeVersion();
  const nodeMajor = parseNodeMajor(nodeVer);
  const nodeOk = Number.isInteger(nodeMajor) && nodeMajor >= MIN_NODE_MAJOR;
  checks.push({
    label: 'Node version',
    ok: nodeOk,
    detail: nodeOk
      ? `${nodeVer} (>= ${MIN_NODE_MAJOR})`
      : `${nodeVer} — Manta needs Node >= ${MIN_NODE_MAJOR}; upgrade Node`,
  });

  // 2. claude on PATH
  const claudeOk = await probes.claudeOnPath();
  checks.push({
    label: 'claude CLI on PATH',
    ok: claudeOk,
    detail: claudeOk
      ? 'found'
      : 'not found — install Claude Code (clones spawn via `claude --print`)',
  });

  // 3. manta-bus MCP registered
  const bus = await probeBus(probes.busRunner);
  checks.push({ label: 'manta-bus MCP server', ok: bus.ok, detail: bus.detail });

  // 4. cwd is a git repo
  const gitOk = await probes.isGitRepo(cwd);
  checks.push({
    label: 'cwd is a git repo',
    ok: gitOk,
    detail: gitOk ? cwd : `${cwd} — run \`git init\` (Manta anchors state at the repo root)`,
  });

  // 5. manta version (informational — always a ✓)
  checks.push({ label: 'manta version', ok: true, detail: probes.mantaVersion() });

  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.length - passed;

  const lines: string[] = ['manta doctor — environment health check', ''];
  let labelWidth = 0;
  for (const c of checks) labelWidth = Math.max(labelWidth, c.label.length);
  for (const c of checks) {
    const mark = c.ok ? '✓' : '✗';
    lines.push(`  ${mark} ${c.label.padEnd(labelWidth)}  ${c.detail}`);
  }
  lines.push('');
  lines.push(
    failed === 0
      ? `All ${checks.length} checks passed.`
      : `${passed}/${checks.length} checks passed, ${failed} need attention (see ✗ above).`,
  );

  // Exit 0 even when checks fail — doctor is a diagnostic, not a gate.
  return { exitCode: 0, stdout: lines.join('\n') };
}
