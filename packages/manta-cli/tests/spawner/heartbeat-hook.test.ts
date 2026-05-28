import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { busPaths, Registry, systemClock } from '@manta/bus';
import { installHeartbeatHook, _resetInstalledWorktrees } from '../../src/spawner/heartbeat-hook.js';

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
      expect(clone!.last_heartbeat_at).toBeGreaterThanOrEqual(before);
      expect(clone!.last_heartbeat_at).toBeLessThanOrEqual(after);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('cross-process race: hook + bus mutations preserve all clones (bug #37 regression)', async () => {
    // The pre-fix hook used a different lock path than proper-lockfile (the
    // bus's locker) and wrote non-atomically with writeFileSync. Two clones
    // racing the bus would silently clobber each other (resurrect DEAD,
    // drop just-registered siblings, or leave torn JSON). This test runs
    // hook touches and bus registers concurrently and asserts: registry
    // always parses, clone A heartbeat advances, EVERY bus-registered B-i
    // survives.
    const root = await makeTmp();
    const worktree = path.join(root, 'worktree');
    await fs.mkdir(worktree, { recursive: true });
    await fs.mkdir(path.join(root, '.manta', 'state'), { recursive: true });

    const paths = busPaths(root);
    const registry = new Registry(paths, systemClock);

    await registry.register({
      clone_id: 'A', mode: 'recon-swarm', parent_pid: process.pid, worktree, metadata: {},
    });

    await installHeartbeatHook(worktree, root, 'A');
    const scriptPath = path.join(worktree, '.manta', 'heartbeat-touch.cjs');
    const regPath = path.join(root, '.manta', 'state', 'registry.json');

    const runHook = (): Promise<void> => new Promise((resolve, reject) => {
      const child = spawn('node', [scriptPath], { stdio: 'ignore' });
      child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`hook exit ${code ?? 'null'}`)));
      child.on('error', reject);
    });

    const N = 12;
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < N; i++) {
      ops.push(runHook());
      const id = `B-${i}`;
      ops.push(registry.register({
        clone_id: id, mode: 'recon-swarm', parent_pid: process.pid, worktree, metadata: {},
      }));
    }
    await Promise.all(ops);

    // 1. Registry parses (no torn JSON)
    const raw = await fs.readFile(regPath, 'utf8');
    const data = JSON.parse(raw) as { clones: Record<string, { last_heartbeat_at: number; state: string }> };

    // 2. Clone A heartbeat advanced past the original registration
    expect(data.clones.A).toBeDefined();
    expect(data.clones.A!.last_heartbeat_at).toBeGreaterThan(0);

    // 3. Every bus-registered B-i survived (no clobber by hook's stale-read writes)
    for (let i = 0; i < N; i++) {
      expect(data.clones[`B-${i}`], `B-${i} missing — hook clobbered bus write`).toBeDefined();
    }
  }, 15_000);

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
      expect(clone!.last_heartbeat_at).toBe(1000);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
