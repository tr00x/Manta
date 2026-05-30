import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { buildScopeGuardHookScript } from './scope-guard-hook.js';

/**
 * Install the always-on scope/safety PreToolUse guard into a clone's worktree.
 *
 * Mirrors `installGitLockHook`: writes the generated `.cjs` under `.manta/`
 * and APPENDS a `PreToolUse` entry to `.claude/settings.local.json` (so it
 * coexists with the heartbeat hook the spawner installs first, and with the
 * test-storm git-lock hook installed after). Unlike git-lock, this guard is
 * installed for EVERY clone — it is the hard enforcement of the scope fence
 * that `--permission-mode bypassPermissions` would otherwise leave to soft
 * priming text alone.
 */
const installedScopeGuardWorktrees = new Set<string>();

export interface InstallScopeGuardOptions {
  cloneId: string;
  allowedPaths: readonly string[];
  forbiddenPaths: readonly string[];
}

export async function installScopeGuardHook(
  worktree: string,
  opts: InstallScopeGuardOptions,
): Promise<void> {
  if (installedScopeGuardWorktrees.has(worktree)) return;

  const claudeDir = path.join(worktree, '.claude');
  await fs.mkdir(claudeDir, { recursive: true });

  const scriptPath = path.join(worktree, '.manta', 'scope-guard-hook.cjs');
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  await fs.writeFile(
    scriptPath,
    buildScopeGuardHookScript({
      worktree,
      allowedPaths: opts.allowedPaths,
      forbiddenPaths: opts.forbiddenPaths,
      cloneId: opts.cloneId,
    }),
    'utf8',
  );

  const hookEntry = {
    matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash',
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
  const preToolUse = hooks.PreToolUse ?? [];
  preToolUse.push(hookEntry);
  hooks.PreToolUse = preToolUse;
  settings.hooks = hooks;

  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');

  installedScopeGuardWorktrees.add(worktree);
}

export function _resetInstalledScopeGuardWorktrees(): void {
  installedScopeGuardWorktrees.clear();
}
