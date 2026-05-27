import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { installHeartbeatHook, _resetInstalledWorktrees } from '../../src/spawner/heartbeat-hook';

describe('heartbeat-hook', () => {
  beforeEach(() => {
    _resetInstalledWorktrees();
  });

  async function makeTmp(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), 'manta-hb-hook-'));
  }

  it('installs .claude/settings.local.json with PreToolUse and PostToolUse hooks', async () => {
    const root = await makeTmp();
    const worktree = path.join(root, 'worktree');
    await fs.mkdir(worktree, { recursive: true });
    try {
      await installHeartbeatHook(worktree, root, 'A');
      const settingsPath = path.join(worktree, '.claude', 'settings.local.json');
      const raw = await fs.readFile(settingsPath, 'utf8');
      const settings = JSON.parse(raw) as Record<string, unknown>;
      expect(settings).toHaveProperty('hooks');
      expect(settings).toHaveProperty('hooks.PostToolUse');
      expect(settings).toHaveProperty('hooks.PreToolUse');
      const post = (settings.hooks as Record<string, unknown>).PostToolUse as Array<Record<string, unknown>>;
      const pre = (settings.hooks as Record<string, unknown>).PreToolUse as Array<Record<string, unknown>>;
      expect(post).toHaveLength(1);
      expect(pre).toHaveLength(1);
      expect(post[0]).toHaveProperty('hooks');
      expect(pre[0]).toHaveProperty('hooks');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('creates heartbeat-touch.cjs script', async () => {
    const root = await makeTmp();
    const worktree = path.join(root, 'worktree');
    await fs.mkdir(worktree, { recursive: true });
    try {
      await installHeartbeatHook(worktree, root, 'A');
      const scriptPath = path.join(worktree, '.manta', 'heartbeat-touch.cjs');
      const content = await fs.readFile(scriptPath, 'utf8');
      expect(content).toContain('CLONE_ID');
      expect(content).toContain('"A"');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('touch script updates last_heartbeat_at in registry', async () => {
    const root = await makeTmp();
    const worktree = path.join(root, 'worktree');
    const stateDir = path.join(root, '.manta', 'state');
    const lockDir = path.join(stateDir, '.locks');
    await fs.mkdir(worktree, { recursive: true });
    await fs.mkdir(lockDir, { recursive: true });

    const registry = {
      version: 1,
      clones: {
        A: {
          clone_id: 'A',
          mode: 'recon-swarm',
          state: 'WORKING',
          last_heartbeat_at: 1000,
          registered_at: 500,
          parent_pid: 1,
          worktree: '/w',
          metadata: {},
        },
      },
    };
    const regPath = path.join(stateDir, 'registry.json');
    await fs.writeFile(regPath, JSON.stringify(registry, null, 2));

    try {
      await installHeartbeatHook(worktree, root, 'A');
      const scriptPath = path.join(worktree, '.manta', 'heartbeat-touch.cjs');

      const before = Date.now();
      execSync(`node "${scriptPath}"`, { timeout: 5000 });
      const after = Date.now();

      const updated = JSON.parse(await fs.readFile(regPath, 'utf8')) as Record<string, unknown>;
      const clone = (updated.clones as Record<string, Record<string, unknown>>).A;
      expect(clone.last_heartbeat_at).toBeGreaterThanOrEqual(before);
      expect(clone.last_heartbeat_at).toBeLessThanOrEqual(after);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('touch script is a no-op for DEAD clones', async () => {
    const root = await makeTmp();
    const worktree = path.join(root, 'worktree');
    const stateDir = path.join(root, '.manta', 'state');
    const lockDir = path.join(stateDir, '.locks');
    await fs.mkdir(worktree, { recursive: true });
    await fs.mkdir(lockDir, { recursive: true });

    const registry = {
      version: 1,
      clones: {
        A: {
          clone_id: 'A',
          mode: 'recon-swarm',
          state: 'DEAD',
          last_heartbeat_at: 1000,
          registered_at: 500,
          parent_pid: 1,
          worktree: '/w',
          metadata: {},
          death_reason: 'test',
          died_at: 2000,
        },
      },
    };
    const regPath = path.join(stateDir, 'registry.json');
    await fs.writeFile(regPath, JSON.stringify(registry, null, 2));

    try {
      await installHeartbeatHook(worktree, root, 'A');
      const scriptPath = path.join(worktree, '.manta', 'heartbeat-touch.cjs');
      execSync(`node "${scriptPath}"`, { timeout: 5000 });

      const updated = JSON.parse(await fs.readFile(regPath, 'utf8')) as Record<string, unknown>;
      const clone = (updated.clones as Record<string, Record<string, unknown>>).A;
      expect(clone.last_heartbeat_at).toBe(1000);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
