import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRuntime, type Runtime } from '../../src/runtime.js';
import {
  runShareCommand,
  ShareError,
  type ShareDeps,
} from '../../src/commands/share.js';
import { createLockfileStore } from '../../src/library/lockfile.js';
import { createLocalStore } from '../../src/library/local-store.js';
import { createRegistryClient, type NetworkRunner } from '../../src/library/registry-client.js';
import { runInstallCommand, type InstallRuntime } from '../../src/commands/install.js';

const CAST_ID = 'cast-1780023574334';
const CLONE_ID = 'B';
const FIXED_NOW = '2026-05-29T03:00:00Z';

let repoRoot: string;
let homeDir: string;
let outDir: string;
let rt: Runtime;

const VALID_SKILL = `---
name: share-sample
description: A sample shared skill used by the share command round-trip test.
audience: clone
version: 0.1.0
related: []
---

# share-sample

## Purpose

Demonstrates a shippable contribution.

## Allowed

Read anything.

## Forbidden

Nothing in particular.

## Examples

An example.
`;

async function writeJson(p: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(value, null, 2), 'utf8');
}

async function buildFixture(opts: { diff?: string; recentMessages?: number } = {}): Promise<void> {
  // git repo marker (createRuntime requires .git)
  await fs.mkdir(path.join(repoRoot, '.git'), { recursive: true });

  // cast manifest
  await writeJson(path.join(repoRoot, '.manta', 'state', 'casts', `${CAST_ID}.json`), {
    version: 1,
    cast_id: CAST_ID,
    mode: 'forking-realities',
    clones: [{ clone_id: CLONE_ID, assignment: null }],
    policy: { peer_messaging: 'denied', auto_merge_threshold: null, session_mode: 'batch' },
    created_at: 1780023574334,
  });

  const taskContract = {
    cloneId: CLONE_ID,
    mode: 'forking-realities',
    task: 'Implement the sample contribution.',
    scope: { allowedPaths: ['.'], forbiddenPaths: ['.manta/state'], maxFilesChanged: 30 },
    approachHint: null,
    siblingClones: ['A'],
    deadlineSeconds: 1200,
    sessionMode: 'batch',
  };
  await writeJson(path.join(repoRoot, '.manta', 'state', 'contracts', `${CLONE_ID}.json`), taskContract);

  // snapshot
  const recent = Array.from({ length: opts.recentMessages ?? 0 }, (_, i) => ({
    role: 'user' as const,
    content: `msg ${i}`,
    timestamp: '2026-05-29T02:00:00.000Z',
  }));
  await writeJson(
    path.join(repoRoot, '.manta', 'snapshots', CAST_ID, `${CLONE_ID}.snapshot.json`),
    {
      version: 1,
      castId: CAST_ID,
      parentSessionId: 'sess-internal',
      parentPid: 4242,
      createdAt: '2026-05-29T02:59:40.780Z',
      taskContract,
      recentMessages: recent,
      activeTodos: [],
      openFiles: [],
      parentWorktree: repoRoot,
      cloneWorktree: path.join(repoRoot, '.manta', 'worktrees', `clone-${CLONE_ID}`),
      mode: 'forking-realities',
      budget: { tokensTotal: 0, tokensUsed: 0, dollarsTotal: 5, dollarsUsed: 0 },
      ttlSeconds: 1200,
      siblingCloneIds: ['A'],
      sessionMode: 'batch',
    },
  );

  // events.jsonl (a couple of winner events)
  const events = [
    { id: '1-a', ts: 1780023574500, type: 'register', clone_id: CLONE_ID, payload: { mode: 'forking-realities' } },
    { id: '2-a', ts: 1780023575000, type: 'heartbeat', clone_id: CLONE_ID, payload: { state: 'WORKING', progress: 'secret stuff' } },
  ];
  await fs.mkdir(path.join(repoRoot, '.manta', 'state'), { recursive: true });
  await fs.writeFile(
    path.join(repoRoot, '.manta', 'state', 'events.jsonl'),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    'utf8',
  );

  // post-mortem
  await fs.mkdir(path.join(repoRoot, 'docs', 'post-mortems'), { recursive: true });
  await fs.writeFile(
    path.join(repoRoot, 'docs', 'post-mortems', `2026-05-29-${CAST_ID}-${CLONE_ID}.md`),
    `# Post-mortem ${CLONE_ID}\n\n## Reason\n\nShipped the sample contribution cleanly.\n`,
    'utf8',
  );

  // clone worktree with a shippable skill
  const skillDir = path.join(repoRoot, '.manta', 'worktrees', `clone-${CLONE_ID}`, 'skills', 'share-sample');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), VALID_SKILL, 'utf8');

  rt = await createRuntime({ repoRoot, homeDir });
}

interface PublishProbe {
  publishCalls: number;
  lastAccess: string | null;
}

/**
 * Fake publish seams (Chunk 3). The default runner is logged-in, owns the
 * scope, and a confirmer that says yes twice — the all-pass happy path. Tests
 * override per-case. Real execa-npm + stdin readline are NEVER reached.
 */
function fakeDeps(
  diff = 'diff --git a/x.ts b/x.ts\n+const ok = 1;\n',
  publish: {
    who?: string | null;
    scopePkgs?: string[];
    answers?: boolean[];
    probe?: PublishProbe;
  } = {},
): Partial<ShareDeps> {
  let i = 0;
  return {
    now: () => FIXED_NOW,
    resolveGitRemote: async () => null,
    resolveWorktreeDiff: async () => diff,
    resolveCloneWorktree: ({ repoRoot: r, cloneId }) =>
      path.join(r, '.manta', 'worktrees', `clone-${cloneId}`),
    publishRunner: {
      whoami: async () => (publish.who === undefined ? 'tester' : publish.who),
      listScopePackages: async () => publish.scopePkgs ?? ['@manta-library/other'],
      publish: async (_tarball, opts) => {
        if (publish.probe) {
          publish.probe.publishCalls += 1;
          publish.probe.lastAccess = opts.access;
        }
      },
    },
    confirmer: {
      confirm: async () => {
        const ans = publish.answers ?? [true, true];
        const a = ans[i] ?? false;
        i += 1;
        return a;
      },
    },
  };
}

function baseOpts(extra: Record<string, unknown> = {}): Parameters<typeof runShareCommand>[1] {
  return {
    castId: CAST_ID,
    clone: CLONE_ID,
    name: '@manta-library/share-sample',
    version: '0.1.0',
    author: 'tester',
    license: 'MIT',
    mantaVersionCompat: '>=0.0.0',
    outDir,
    deps: fakeDeps(),
    ...extra,
  } as Parameters<typeof runShareCommand>[1];
}

beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-share-repo-'));
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-share-home-'));
  outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-share-out-'));
});
afterEach(async () => {
  if (rt) await rt.dispose();
  for (const d of [repoRoot, homeDir, outDir]) {
    await fs.rm(d, { recursive: true, force: true });
  }
});

describe('runShareCommand — local bundle', () => {
  it('produces a bundle; round-trip: manta install consumes it', async () => {
    await buildFixture();
    const result = await runShareCommand(rt, baseOpts());
    expect(result.packageName).toBe('@manta-library/share-sample');
    expect(result.winningCloneId).toBe('B');
    await expect(fs.access(result.tarballPath)).resolves.toBeUndefined();

    // Cross-phase round-trip: Phase 7a install consumes the bundle.
    const installRt: InstallRuntime = {
      repoRoot,
      lockfile: createLockfileStore({ repoRoot }),
      localStore: createLocalStore({ homeDir }),
      registryClient: createRegistryClient({
        runner: {
          npmPack: () => Promise.reject(new Error('no net')),
          gitClone: () => Promise.reject(new Error('no net')),
        } as NetworkRunner,
        offline: true,
      }),
      mantaCliVersion: '0.7.2',
    };
    // Bug #55 fix landed in this commit's ceremony: LOCAL_TGZ now accepts
    // both `.tgz` and `.tar.gz`, so `manta share`'s native bundle name
    // (`*.manta-pkg.tar.gz`) works without the previous .tgz-rename shim.
    // The round-trip canary is now end-to-end as the plan intended.
    const installed = await runInstallCommand(installRt, { spec: result.tarballPath, offline: true });
    expect(installed.packageName).toBe('@manta-library/share-sample');
    expect(installed.contributedSkills).toBe(1);
    expect(await installRt.localStore.isInstalled(installed.packageName, installed.version)).toBe(true);
  });

  it('a secret in the worktree diff → share_secret_detected (exit 22), no tarball', async () => {
    await buildFixture();
    const opts = baseOpts({
      deps: fakeDeps('diff --git a/x b/x\n+const KEY = "AKIAIOSFODNN7EXAMPLE";\n'),
    });
    await expect(runShareCommand(rt, opts)).rejects.toMatchObject({
      code: 'share_secret_detected',
      exitCode: 22,
    });
  });

  it('--non-interactive with a non-fatal warning → share_warnings_unaccepted (exit 24)', async () => {
    await buildFixture({ recentMessages: 2 }); // dropped transcript → warning
    await expect(
      runShareCommand(rt, baseOpts({ nonInteractive: true })),
    ).rejects.toMatchObject({ code: 'share_warnings_unaccepted', exitCode: 24 });
  });

  it('a warning with --accept-warnings proceeds', async () => {
    await buildFixture({ recentMessages: 2 });
    const result = await runShareCommand(rt, baseOpts({ acceptWarnings: true }));
    expect(result.warnings.some((w) => w.severity === 'warning')).toBe(true);
    await expect(fs.access(result.tarballPath)).resolves.toBeUndefined();
  });

  it('no --clone and no merge-review → share_no_winner (exit 21)', async () => {
    await buildFixture();
    const opts = baseOpts();
    delete (opts as { clone?: string }).clone;
    await expect(runShareCommand(rt, opts)).rejects.toMatchObject({
      code: 'share_no_winner',
      exitCode: 21,
    });
  });

  it('a missing cast → share_cast_not_found (exit 20)', async () => {
    await buildFixture();
    await expect(
      runShareCommand(rt, baseOpts({ castId: 'cast-9999999999999' })),
    ).rejects.toMatchObject({ code: 'share_cast_not_found', exitCode: 20 });
  });

  it('two shares of the same fixture are byte-identical (determinism)', async () => {
    await buildFixture();
    const out2 = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-share-out2-'));
    try {
      const r1 = await runShareCommand(rt, baseOpts());
      const r2 = await runShareCommand(rt, baseOpts({ outDir: out2 }));
      const b1 = await fs.readFile(r1.tarballPath);
      const b2 = await fs.readFile(r2.tarballPath);
      expect(b1.equals(b2)).toBe(true);
    } finally {
      await fs.rm(out2, { recursive: true, force: true });
    }
  });

  it('ShareError is the thrown type', async () => {
    await buildFixture();
    let caught: unknown;
    try {
      await runShareCommand(rt, baseOpts({ castId: 'cast-0000000000000' }));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ShareError);
  });
});

describe('runShareCommand — --publish (Chunk 3)', () => {
  it('publish + non-interactive → share_publish_blocked (command-layer defense)', async () => {
    await buildFixture();
    await expect(
      runShareCommand(rt, baseOpts({ publish: true, nonInteractive: true })),
    ).rejects.toMatchObject({ code: 'share_publish_blocked', exitCode: 27 });
  });

  it('interactive publish with all gates passing → publishes once with access:public', async () => {
    await buildFixture();
    const probe: PublishProbe = { publishCalls: 0, lastAccess: null };
    const result = await runShareCommand(
      rt,
      baseOpts({ publish: true, deps: fakeDeps(undefined, { probe }) }),
    );
    expect(result.published).toBe('@manta-library/share-sample@0.1.0');
    expect(probe.publishCalls).toBe(1);
    expect(probe.lastAccess).toBe('public');
  });

  it('a declined confirmation → share_publish_blocked; the local tarball survives', async () => {
    await buildFixture();
    const probe: PublishProbe = { publishCalls: 0, lastAccess: null };
    let caught: ShareError | undefined;
    try {
      await runShareCommand(
        rt,
        baseOpts({ publish: true, deps: fakeDeps(undefined, { answers: [false], probe }) }),
      );
    } catch (e) {
      caught = e as ShareError;
    }
    expect(caught?.code).toBe('share_publish_blocked');
    expect(probe.publishCalls).toBe(0);
    // The bundle assembled before the publish gate; it must remain on disk.
    const tarball = caught?.details.tarballPath as string;
    await expect(fs.access(tarball)).resolves.toBeUndefined();
  });

  it('not-logged-in → share_publish_blocked, publish never called', async () => {
    await buildFixture();
    const probe: PublishProbe = { publishCalls: 0, lastAccess: null };
    await expect(
      runShareCommand(rt, baseOpts({ publish: true, deps: fakeDeps(undefined, { who: null, probe }) })),
    ).rejects.toMatchObject({ code: 'share_publish_blocked' });
    expect(probe.publishCalls).toBe(0);
  });
});
