import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Write a `.claude/settings.local.json` into the clone's worktree that
 * installs a PostToolUse hook. The hook touches the clone's
 * `last_heartbeat_at` in the shared registry on every tool call — including
 * Claude Code built-in tools (Read, Write, Edit, Bash) that do NOT go
 * through MCP. This closes the gap where the bus auto-touch (bug #9 fix)
 * only fires on `manta.*` MCP calls but implementation clones spend most
 * of their time in non-MCP tools.
 *
 * Uses proper-lockfile for safe concurrent access to registry.json (same
 * locking primitive as `atomicMutateJson` in `@manta/bus`).
 */
export async function installHeartbeatHook(
  worktree: string,
  repoRoot: string,
  cloneId: string,
): Promise<void> {
  const claudeDir = path.join(worktree, '.claude');
  await fs.mkdir(claudeDir, { recursive: true });

  const registryPath = path.join(repoRoot, '.manta', 'state', 'registry.json');
  const lockDir = path.join(repoRoot, '.manta', 'state', '.locks');

  const touchScript = buildTouchScript(registryPath, lockDir, cloneId);
  const scriptPath = path.join(worktree, '.manta', 'heartbeat-touch.cjs');
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  await fs.writeFile(scriptPath, touchScript, 'utf8');

  const settings = {
    hooks: {
      PostToolUse: [
        {
          matcher: '',
          hooks: [
            {
              type: 'command' as const,
              command: `node "${scriptPath}"`,
              timeout: 5000,
            },
          ],
        },
      ],
    },
  };

  await fs.writeFile(
    path.join(claudeDir, 'settings.local.json'),
    JSON.stringify(settings, null, 2),
    'utf8',
  );
}

function buildTouchScript(
  registryPath: string,
  lockDir: string,
  cloneId: string,
): string {
  return `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const REGISTRY = ${JSON.stringify(registryPath)};
const LOCK_DIR = ${JSON.stringify(lockDir)};
const CLONE_ID = ${JSON.stringify(cloneId)};
const LOCK_FILE = path.join(LOCK_DIR, 'registry.json.lock');

// Minimal lock: mkdir-based (same as proper-lockfile's stale check).
// We use a simpler approach: try mkdir, retry once after 50ms, give up.
// This is a best-effort touch — missing one is fine, the threshold is 300s.
function tryLock() {
  try { fs.mkdirSync(LOCK_FILE); return true; } catch { return false; }
}
function unlock() {
  try { fs.rmdirSync(LOCK_FILE); } catch { /* already removed */ }
}

let locked = tryLock();
if (!locked) {
  // One retry after 50ms
  setTimeout(() => {
    locked = tryLock();
    if (locked) run();
  }, 50);
} else {
  run();
}

function run() {
  try {
    const raw = fs.readFileSync(REGISTRY, 'utf8');
    const data = JSON.parse(raw);
    const clone = data.clones && data.clones[CLONE_ID];
    if (clone && clone.state !== 'DEAD') {
      clone.last_heartbeat_at = Date.now();
      fs.writeFileSync(REGISTRY, JSON.stringify(data, null, 2));
    }
  } catch { /* registry missing or corrupt — skip */ }
  unlock();
}
`;
}
