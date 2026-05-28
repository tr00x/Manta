import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { buildGitLockHookScript } from '../hooks/git-lock-hook.js';

const installedGitLockWorktrees = new Set<string>();

export async function installGitLockHook(
  worktree: string,
  locksPath: string,
  cloneId: string,
): Promise<void> {
  if (installedGitLockWorktrees.has(worktree)) return;

  const claudeDir = path.join(worktree, '.claude');
  await fs.mkdir(claudeDir, { recursive: true });

  const scriptPath = path.join(worktree, '.manta', 'git-lock-hook.cjs');
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  await fs.writeFile(scriptPath, buildGitLockHookScript(locksPath, cloneId), 'utf8');

  const hookEntry = {
    matcher: 'Bash',
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
    // No existing settings
  }

  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  const preToolUse = hooks.PreToolUse ?? [];
  preToolUse.push(hookEntry);
  hooks.PreToolUse = preToolUse;
  settings.hooks = hooks;

  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');

  installedGitLockWorktrees.add(worktree);
}

export function _resetInstalledGitLockWorktrees(): void {
  installedGitLockWorktrees.clear();
}
