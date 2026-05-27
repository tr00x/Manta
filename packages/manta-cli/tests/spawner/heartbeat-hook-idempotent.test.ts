import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { installHeartbeatHook, _resetInstalledWorktrees } from '../../src/spawner/heartbeat-hook';

describe('heartbeat-hook idempotency (shared worktree)', () => {
  beforeEach(() => {
    _resetInstalledWorktrees();
  });

  async function makeTmp(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), 'manta-hb-idem-'));
  }

  it('second call on same worktree does not duplicate hooks in settings.local.json', async () => {
    const root = await makeTmp();
    const worktree = path.join(root, 'worktree');
    await fs.mkdir(worktree, { recursive: true });
    try {
      await installHeartbeatHook(worktree, root, 'A');
      await installHeartbeatHook(worktree, root, 'B');

      const settingsPath = path.join(worktree, '.claude', 'settings.local.json');
      const raw = await fs.readFile(settingsPath, 'utf8');
      const settings = JSON.parse(raw) as Record<string, unknown>;
      const hooks = settings.hooks as Record<string, unknown[]>;
      expect(hooks.PreToolUse).toHaveLength(1);
      expect(hooks.PostToolUse).toHaveLength(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('heartbeat script uses MANTA_CLONE_ID env var for shared worktree support', async () => {
    const root = await makeTmp();
    const worktree = path.join(root, 'worktree');
    await fs.mkdir(worktree, { recursive: true });
    try {
      await installHeartbeatHook(worktree, root, 'A');
      const scriptPath = path.join(worktree, '.manta', 'heartbeat-touch.cjs');
      const content = await fs.readFile(scriptPath, 'utf8');
      expect(content).toContain('MANTA_CLONE_ID');
      expect(content).toContain('process.env');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
