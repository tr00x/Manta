import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
// Resolve proper-lockfile through @manta/bus's dep chain. The generated .cjs
// hook runs from inside a clone's worktree, where pnpm hoisting may differ
// from the main repo, so we embed the absolute host-path resolved at install
// time. @manta/bus is a direct dep of this package; proper-lockfile is a
// direct dep of @manta/bus, so chained resolve always lands on the workspace
// copy that the bus itself uses.
const PROPER_LOCKFILE_PATH = createRequire(require_.resolve('@manta/bus'))
  .resolve('proper-lockfile');

/**
 * Write a `.claude/settings.local.json` into the clone's worktree that
 * installs PreToolUse + PostToolUse hooks. The hook touches the clone's
 * `last_heartbeat_at` in the shared registry on every tool call — including
 * Claude Code built-in tools (Read, Write, Edit, Bash) that do NOT go
 * through MCP. This closes the gap where the bus auto-touch (bug #9 fix)
 * only fires on `manta.*` MCP calls but implementation clones spend most
 * of their time in non-MCP tools.
 *
 * The hook locks via `proper-lockfile` on `${registry}.lock` — the **same**
 * lock path and same locker library used by the bus's `atomicMutateJson`
 * (bug #37 fix). Mutual exclusion with the bus is guaranteed because both
 * sides use the same primitive on the same path. Writes go through
 * tmp+rename so a crashed hook cannot leave torn JSON behind.
 */
const installedWorktrees = new Set<string>();

export async function installHeartbeatHook(
  worktree: string,
  repoRoot: string,
  cloneId: string,
): Promise<void> {
  if (installedWorktrees.has(worktree)) return;

  const claudeDir = path.join(worktree, '.claude');
  await fs.mkdir(claudeDir, { recursive: true });

  const registryPath = path.join(repoRoot, '.manta', 'state', 'registry.json');
  const touchScript = buildTouchScript(registryPath, cloneId);
  const scriptPath = path.join(worktree, '.manta', 'heartbeat-touch.cjs');
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  await fs.writeFile(scriptPath, touchScript, 'utf8');

  const hookEntry = {
    matcher: '',
    hooks: [
      {
        type: 'command' as const,
        command: `node "${scriptPath}"`,
        timeout: 5000,
      },
    ],
  };

  const settingsPath = path.join(claudeDir, 'settings.local.json');
  let settings: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(settingsPath, 'utf8');
    settings = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // No existing settings — start fresh
  }

  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  hooks.PreToolUse = [hookEntry];
  hooks.PostToolUse = [hookEntry];
  settings.hooks = hooks;

  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');

  installedWorktrees.add(worktree);
}

export function _resetInstalledWorktrees(): void {
  installedWorktrees.clear();
}

function buildTouchScript(registryPath: string, cloneId: string): string {
  return `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const lockfile = require(${JSON.stringify(PROPER_LOCKFILE_PATH)});

const REGISTRY = ${JSON.stringify(registryPath)};
const CLONE_ID = process.env.MANTA_CLONE_ID || ${JSON.stringify(cloneId)};
// Mirror @manta/bus's atomic-fs LOCK_OPTS verbatim so hook + bus share the
// same retry budget and stale-steal threshold on the same lock file.
const LOCK_OPTS = {
  retries: { retries: 50, minTimeout: 5, maxTimeout: 50, factor: 1.2 },
  stale: 30000,
  realpath: false,
};

async function run() {
  let release;
  try {
    release = await lockfile.lock(REGISTRY, LOCK_OPTS);
  } catch {
    return; // could not acquire lock under retry budget — best-effort skip
  }
  try {
    let raw;
    try { raw = fs.readFileSync(REGISTRY, 'utf8'); } catch { return; }
    if (!raw) return; // empty placeholder, bus has not initialized yet
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    const clone = data.clones && data.clones[CLONE_ID];
    if (!clone || clone.state === 'DEAD') return;
    clone.last_heartbeat_at = Date.now();
    const tmp = REGISTRY + '.tmp.' + process.pid + '.' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, REGISTRY);
  } finally {
    try { await release(); } catch { /* already released or stolen */ }
  }
}

run().catch(() => { /* best-effort: missing one heartbeat is fine */ });
`;
}
