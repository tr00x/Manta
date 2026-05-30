import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  installScopeGuardHook,
  _resetInstalledScopeGuardWorktrees,
} from '../../src/spawner/scope-guard-hook-installer.js';
import { spawnClone, runFakeCloneScript } from '../../src/spawner/clone-spawner.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';
import { makeRegistryFake } from '../helpers/registryFake.js';
import { makeSnapshotFor } from '../helpers/snapshotFixture.js';

interface HookEntry {
  matcher: string;
  hooks: { type: string; command: string; timeout?: number }[];
}
interface Settings {
  hooks?: { PreToolUse?: HookEntry[]; PostToolUse?: HookEntry[] };
}

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'fake-clone.mjs',
);

function fakeCasts() {
  return {
    create(input: { cast_id: string; mode: string; clones: unknown[]; policy: unknown }) {
      return Promise.resolve({
        version: 1 as const,
        cast_id: input.cast_id,
        mode: input.mode as never,
        clones: input.clones as never,
        policy: input.policy as never,
        created_at: 1_700_000_000_000,
      });
    },
  };
}

describe('installScopeGuardHook', () => {
  let tmpDir: string;
  let worktree: string;

  beforeEach(async () => {
    _resetInstalledScopeGuardWorktrees();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-scope-installer-'));
    worktree = path.join(tmpDir, 'wt');
    await fs.mkdir(worktree, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function readSettings(): Promise<Settings> {
    const raw = await fs.readFile(path.join(worktree, '.claude', 'settings.local.json'), 'utf8');
    return JSON.parse(raw) as Settings;
  }

  it('writes the generated .cjs guard script into .manta/', async () => {
    await installScopeGuardHook(worktree, {
      cloneId: 'A',
      allowedPaths: ['src'],
      forbiddenPaths: ['.manta/state'],
    });
    const script = await fs.readFile(path.join(worktree, '.manta', 'scope-guard-hook.cjs'), 'utf8');
    expect(script).toContain('permissionDecision');
    expect(script).toContain("'deny'");
  });

  it('appends a PreToolUse entry pointing at the guard script', async () => {
    await installScopeGuardHook(worktree, {
      cloneId: 'A',
      allowedPaths: ['src'],
      forbiddenPaths: [],
    });
    const settings = await readSettings();
    const entries = settings.hooks?.PreToolUse ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]!.matcher).toContain('Bash');
    expect(entries[0]!.hooks[0]!.command).toContain('scope-guard-hook.cjs');
  });

  it('coexists with a pre-existing PreToolUse hook (append, not replace)', async () => {
    // Simulate the heartbeat hook the spawner installs first.
    const claudeDir = path.join(worktree, '.claude');
    await fs.mkdir(claudeDir, { recursive: true });
    const existing = {
      hooks: {
        PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'node heartbeat.cjs' }] }],
        PostToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'node heartbeat.cjs' }] }],
      },
    };
    await fs.writeFile(path.join(claudeDir, 'settings.local.json'), JSON.stringify(existing), 'utf8');

    await installScopeGuardHook(worktree, {
      cloneId: 'A',
      allowedPaths: ['src'],
      forbiddenPaths: [],
    });

    const settings = await readSettings();
    expect(settings.hooks?.PreToolUse).toHaveLength(2);
    expect(settings.hooks?.PreToolUse?.[0]!.hooks[0]!.command).toContain('heartbeat.cjs');
    expect(settings.hooks?.PreToolUse?.[1]!.hooks[0]!.command).toContain('scope-guard-hook.cjs');
    // PostToolUse untouched.
    expect(settings.hooks?.PostToolUse).toHaveLength(1);
  });

  it('is idempotent per worktree (no duplicate entries on a second call)', async () => {
    await installScopeGuardHook(worktree, { cloneId: 'A', allowedPaths: ['src'], forbiddenPaths: [] });
    await installScopeGuardHook(worktree, { cloneId: 'A', allowedPaths: ['src'], forbiddenPaths: [] });
    const settings = await readSettings();
    expect(settings.hooks?.PreToolUse).toHaveLength(1);
  });

  it('bakes allowedPaths and forbiddenPaths into the generated script', async () => {
    await installScopeGuardHook(worktree, {
      cloneId: 'Z',
      allowedPaths: ['packages/manta-cli/src/spawner'],
      forbiddenPaths: ['secrets/'],
    });
    const script = await fs.readFile(path.join(worktree, '.manta', 'scope-guard-hook.cjs'), 'utf8');
    expect(script).toContain('packages/manta-cli/src/spawner');
    expect(script).toContain('secrets/');
  });
});

describe('spawnClone installs the scope guard for ALL clones (not just test-storm)', () => {
  let fx: RepoFixture | undefined;

  beforeEach(() => {
    _resetInstalledScopeGuardWorktrees();
  });

  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  it('a recon-swarm clone gets a scope-guard PreToolUse hook in its worktree', async () => {
    fx = await makeRepoFixture();
    const handle = await spawnClone({
      repoRoot: fx.root,
      snapshot: makeSnapshotFor({
        cloneId: 'A',
        castId: 'cast-guard',
        scope: { allowedPaths: ['packages/x'], forbiddenPaths: ['.manta/state', 'secrets/'], maxFilesChanged: 5 },
      }),
      worktree: fx.root,
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      registry: makeRegistryFake(),
      casts: fakeCasts(),
      castMode: 'recon-swarm',
      castPolicy: { peer_messaging: 'allowed', auto_merge_threshold: null, session_mode: 'batch' },
      castRoster: [{ clone_id: 'A', assignment: null }],
    });
    await handle.exit;

    const raw = await fs.readFile(path.join(fx.root, '.claude', 'settings.local.json'), 'utf8');
    const settings = JSON.parse(raw) as Settings;
    const commands = (settings.hooks?.PreToolUse ?? []).flatMap((e) => e.hooks.map((h) => h.command));
    expect(commands.some((c) => c.includes('scope-guard-hook.cjs'))).toBe(true);
    // The script itself must have been written with this clone's scope baked in.
    const script = await fs.readFile(path.join(fx.root, '.manta', 'scope-guard-hook.cjs'), 'utf8');
    expect(script).toContain('packages/x');
  });
});
