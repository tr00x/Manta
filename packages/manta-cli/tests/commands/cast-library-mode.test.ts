import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runCastCommand } from '../../src/commands/cast.js';
import { runFakeCloneScript } from '../../src/spawner/clone-spawner.js';
import { createReporter, MemorySink } from '../../src/output/reporter.js';
import { createRuntime } from '../../src/runtime.js';
import { createLocalStore } from '../../src/library/local-store.js';
import { createLockfileStore } from '../../src/library/lockfile.js';
import { computeDirDigest } from '../../src/library/dir-digest.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';
import { MANTA_CLI_VERSION } from '../../src/library/cli-version.js';

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'fake-clone.mjs',
);

const sampleLibraryPackage = {
  schemaVersion: 1,
  name: '@manta-library/sample-mode-pack',
  version: '0.1.0',
  description: 'In-test library package that contributes one library mode.',
  author: 'cast-library-test',
  license: 'MIT',
  mantaVersionCompat: '>=0.0.0',
  contributes: {
    modes: [
      {
        name: 'mega-refactor',
        description: 'In-test library mode that inherits the recon-swarm dispatcher.',
        basedOn: 'recon-swarm',
        cloneCount: { min: 1, max: 2 },
        sessionMode: 'batch',
      },
    ],
  },
};

async function seedLibraryInstall(opts: {
  fakeHome: string;
  repoRoot: string;
}): Promise<void> {
  const localStore = createLocalStore({ homeDir: opts.fakeHome });
  const installDir = localStore.pathFor('@manta-library/sample-mode-pack', '0.1.0');
  await fs.mkdir(installDir, { recursive: true });
  await fs.writeFile(path.join(installDir, 'manta-package.json'), JSON.stringify(sampleLibraryPackage, null, 2));
  // Hash-pin verification (Phase 7a Chunk 2 task 2.4) compares the on-disk
  // digest against `directoryDigest`, so the seed must capture the real
  // digest of the files written above — placeholder strings get rejected
  // with exit 19 before the cast even tries to spawn.
  const directoryDigest = await computeDirDigest(installDir);
  await localStore.upsertIndexEntry({
    packageName: '@manta-library/sample-mode-pack',
    version: '0.1.0',
    path: installDir,
    contributes: { modes: ['mega-refactor'], skills: [], commands: [], templates: [] },
    installedAt: '2026-05-28T11:30:00.000Z',
    integrity: 'sha256-AAAaaa==',
  });

  const lockfile = createLockfileStore({ repoRoot: opts.repoRoot });
  await lockfile.write({
    schemaVersion: 1,
    mantaVersion: MANTA_CLI_VERSION,
    generatedAt: '2026-05-28T11:30:00.000Z',
    packages: {
      '@manta-library/sample-mode-pack': {
        version: '0.1.0',
        resolved: 'file://fixture',
        integrity: 'sha256-AAAaaa==',
        directoryDigest,
        contributes: { modes: ['mega-refactor'], skills: [], commands: [], templates: [] },
        mantaVersionCompat: '>=0.0.0',
        installedAt: '2026-05-28T11:30:00.000Z',
      },
    },
  });
}

describe('cast command — library mode integration', () => {
  let fx: RepoFixture | undefined;
  let fakeHome: string | undefined;
  let restoreHome: string | undefined;

  afterEach(async () => {
    if (restoreHome !== undefined) {
      process.env.HOME = restoreHome;
      restoreHome = undefined;
    }
    if (fakeHome) {
      await fs.rm(fakeHome, { recursive: true, force: true });
      fakeHome = undefined;
    }
    await fx?.cleanup();
    fx = undefined;
  });

  it('lists library modes alongside built-ins in unknown-mode error', async () => {
    fx = await makeRepoFixture();
    fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-cast-library-home-'));
    restoreHome = process.env.HOME;
    process.env.HOME = fakeHome;
    await seedLibraryInstall({ fakeHome, repoRoot: fx.root });

    const rt = await createRuntime({ repoRoot: fx.root, homeDir: fakeHome });
    let caught: Error | undefined;
    try {
      await runCastCommand(rt, {
        mode: 'definitely-not-a-mode' as never,
        task: 't',
        cloneCount: 1,
        cycleIntervalMs: 50,
        runner: runFakeCloneScript({ scriptPath: fixturePath }),
        reporter: createReporter({ sink: new MemorySink() }),
        tickBudgetMs: 1_000,
        castId: 'cast-unknown',
        budgetUsdPerClone: 5,
        budgetUsdPerCast: 15,
        verifyMcp: false,
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain('recon-swarm');
    expect(caught!.message).toContain('mega-refactor');
  });

  it('rejects mantaVersionCompat-incompatible lockfile with exit 16', async () => {
    fx = await makeRepoFixture();
    fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-cast-library-home-'));
    restoreHome = process.env.HOME;
    process.env.HOME = fakeHome;
    await seedLibraryInstall({ fakeHome, repoRoot: fx.root });

    // Overwrite the lockfile with a too-strict compat range.
    const lockfile = createLockfileStore({ repoRoot: fx.root });
    const existing = await lockfile.read();
    expect(existing).not.toBeNull();
    await lockfile.write({
      ...existing!,
      packages: {
        ...existing!.packages,
        '@manta-library/sample-mode-pack': {
          ...existing!.packages['@manta-library/sample-mode-pack']!,
          mantaVersionCompat: '>=99.0.0',
        },
      },
    });

    const rt = await createRuntime({ repoRoot: fx.root, homeDir: fakeHome });
    let caught: { message: string; exitCode?: number } | undefined;
    try {
      await runCastCommand(rt, {
        mode: 'recon-swarm',
        task: 't',
        cloneCount: 1,
        cycleIntervalMs: 50,
        runner: runFakeCloneScript({ scriptPath: fixturePath }),
        reporter: createReporter({ sink: new MemorySink() }),
        tickBudgetMs: 1_000,
        castId: 'cast-compat',
        budgetUsdPerClone: 5,
        budgetUsdPerCast: 15,
        verifyMcp: false,
      });
    } catch (err) {
      caught = err as { message: string; exitCode?: number };
    }
    expect(caught).toBeDefined();
    expect(caught!.exitCode).toBe(16);
    expect(caught!.message).toContain('@manta-library/sample-mode-pack');
    expect(caught!.message).toContain('>=99.0.0');
    expect(caught!.message).toContain('Upgrade');
  });

  it('recognises a library mode and routes through its basedOn dispatcher', async () => {
    fx = await makeRepoFixture();
    fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-cast-library-home-'));
    restoreHome = process.env.HOME;
    process.env.HOME = fakeHome;
    await seedLibraryInstall({ fakeHome, repoRoot: fx.root });

    const rt = await createRuntime({
      repoRoot: fx.root,
      homeDir: fakeHome,
      thresholdOverrides: { heartbeatTimeoutMs: 100, startupGraceMs: 100, parentPidCheckEnabled: false },
    });
    const sink = new MemorySink();
    const result = await runCastCommand(rt, {
      mode: 'mega-refactor' as never,
      task: 't',
      cloneCount: 2,
      cycleIntervalMs: 50,
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      reporter: createReporter({ sink }),
      tickBudgetMs: 15_000,
      castId: 'cast-library-mode',
      budgetUsdPerClone: 5,
      budgetUsdPerCast: 15,
      verifyMcp: false,
    });
    expect(result.exitCode).toBe(0);
    // Reporter captured the library-mode resolution event.
    const libEvent = sink.lines.find((l) => l.event === 'cast.library_mode_resolved');
    expect(libEvent).toBeDefined();
    expect(libEvent!.payload.libraryMode).toBe('mega-refactor');
    expect(libEvent!.payload.basedOn).toBe('recon-swarm');
    // Cast manifest records the basedOn host dispatcher in `mode`.
    const manifestPath = path.join(fx.root, '.manta', 'state', 'casts', 'cast-library-mode.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as { mode: string };
    expect(manifest.mode).toBe('recon-swarm');
  });
});
