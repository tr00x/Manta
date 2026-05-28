import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { busPaths, Registry, systemClock, type BusContext } from '@manta/bus';
import { buildSampleTarball } from '../fixtures/library/build-sample.js';
import { createLockfileStore, type LockfileStore } from '../../src/library/lockfile.js';
import { createLocalStore, type LocalStore } from '../../src/library/local-store.js';
import { createRegistryClient, type NetworkRunner } from '../../src/library/registry-client.js';
import { runInstallCommand, type InstallRuntime } from '../../src/commands/install.js';
import {
  runUninstallCommand,
  UninstallError,
  type UninstallRuntime,
} from '../../src/commands/uninstall.js';

let homeDir: string;
let repoRoot: string;
let fixtureTarball: string;
let fixtureScratchDir: string;

beforeAll(async () => {
  const built = await buildSampleTarball();
  fixtureScratchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-uninstall-fixture-'));
  fixtureTarball = path.join(fixtureScratchDir, 'sample-package.tgz');
  await fs.copyFile(built, fixtureTarball);
});

beforeEach(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-uninstall-home-'));
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-uninstall-repo-'));
});

afterEach(async () => {
  await fs.rm(homeDir, { recursive: true, force: true });
  await fs.rm(repoRoot, { recursive: true, force: true });
});

afterAll(async () => {
  if (fixtureScratchDir) {
    await fs.rm(fixtureScratchDir, { recursive: true, force: true });
  }
});

const stubNetworkRunner = (): NetworkRunner => ({
  npmPack: () => Promise.reject(new Error('network not stubbed')),
  gitClone: () => Promise.reject(new Error('network not stubbed')),
});

function makeInstallRuntime(localStore: LocalStore, lockfile: LockfileStore): InstallRuntime {
  return {
    repoRoot,
    lockfile,
    localStore,
    registryClient: createRegistryClient({ runner: stubNetworkRunner() }),
    mantaCliVersion: '0.7.2',
  };
}

interface FakeRegistryShape {
  list: () => Promise<unknown[]>;
}

function makeRegistryStub(records: Array<Record<string, unknown>>): FakeRegistryShape {
  return { list: async () => records };
}

async function makeBusCtx(): Promise<BusContext> {
  // We only exercise the `registry.list()` surface; the rest is plumbing.
  const paths = busPaths(repoRoot);
  await fs.mkdir(path.dirname(paths.registry), { recursive: true });
  return {
    paths,
    clock: systemClock,
    registry: new Registry(paths, systemClock),
    // The uninstall flow only touches ctx.registry — leave the other stores
    // as no-op stubs cast through unknown to keep the test ergonomic.
  } as unknown as BusContext;
}

async function makeUninstallRuntime(opts: {
  registry?: FakeRegistryShape;
  localStore: LocalStore;
  lockfile: LockfileStore;
}): Promise<UninstallRuntime> {
  const ctx = await makeBusCtx();
  if (opts.registry) {
    (ctx as unknown as { registry: FakeRegistryShape }).registry = opts.registry;
  }
  return {
    repoRoot,
    lockfile: opts.lockfile,
    localStore: opts.localStore,
    ctx,
  };
}

describe('runUninstallCommand — happy path', () => {
  it('removes a single-version install, drops index entry and lockfile entry', async () => {
    const localStore = createLocalStore({ homeDir });
    const lockfile = createLockfileStore({ repoRoot });
    await runInstallCommand(makeInstallRuntime(localStore, lockfile), { spec: fixtureTarball });

    const rt = await makeUninstallRuntime({
      localStore,
      lockfile,
      registry: makeRegistryStub([]),
    });

    const result = await runUninstallCommand(rt, {
      spec: '@manta-library/sample-package@0.1.0',
    });

    expect(result.removedPackageName).toBe('@manta-library/sample-package');
    expect(result.removedVersion).toBe('0.1.0');
    expect(await localStore.isInstalled('@manta-library/sample-package', '0.1.0')).toBe(false);
    const idx = await localStore.readIndex();
    expect(idx.installs).toEqual([]);
    const lock = await lockfile.read();
    expect(lock).not.toBeNull();
    expect(lock!.packages['@manta-library/sample-package']).toBeUndefined();
  });

  it('parses bare name (no version) when exactly one version is installed', async () => {
    const localStore = createLocalStore({ homeDir });
    const lockfile = createLockfileStore({ repoRoot });
    await runInstallCommand(makeInstallRuntime(localStore, lockfile), { spec: fixtureTarball });

    const rt = await makeUninstallRuntime({
      localStore,
      lockfile,
      registry: makeRegistryStub([]),
    });
    const result = await runUninstallCommand(rt, { spec: '@manta-library/sample-package' });
    expect(result.removedVersion).toBe('0.1.0');
  });
});

describe('runUninstallCommand — error paths', () => {
  it('exit 12 (not_installed) for an unknown package', async () => {
    const localStore = createLocalStore({ homeDir });
    const lockfile = createLockfileStore({ repoRoot });
    const rt = await makeUninstallRuntime({
      localStore,
      lockfile,
      registry: makeRegistryStub([]),
    });
    await expect(
      runUninstallCommand(rt, { spec: '@manta-library/unknown' }),
    ).rejects.toMatchObject({
      code: 'uninstall_not_installed',
      exitCode: 12,
    });
  });

  it('exit 18 (ambiguous) when bare name resolves to multiple versions', async () => {
    const localStore = createLocalStore({ homeDir });
    const lockfile = createLockfileStore({ repoRoot });
    // Install version 0.1.0 normally.
    await runInstallCommand(makeInstallRuntime(localStore, lockfile), { spec: fixtureTarball });
    // Hand-write a second version's index entry to simulate the multi-version state.
    await localStore.upsertIndexEntry({
      packageName: '@manta-library/sample-package',
      version: '0.2.0',
      path: localStore.pathFor('@manta-library/sample-package', '0.2.0'),
      contributes: { modes: ['sample-mode'], skills: [], commands: [], templates: [] },
      installedAt: '2026-01-01T00:00:00.000Z',
      integrity: 'sha256-Zm9v',
    });
    // Materialise the directory so isInstalled() returns true if probed.
    await fs.mkdir(localStore.pathFor('@manta-library/sample-package', '0.2.0'), { recursive: true });

    const rt = await makeUninstallRuntime({
      localStore,
      lockfile,
      registry: makeRegistryStub([]),
    });
    let caught: unknown;
    try {
      await runUninstallCommand(rt, { spec: '@manta-library/sample-package' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UninstallError);
    expect(caught).toMatchObject({
      code: 'uninstall_ambiguous',
      exitCode: 18,
    });
    const msg = (caught as UninstallError).message;
    expect(msg).toContain('0.1.0');
    expect(msg).toContain('0.2.0');
  });

  it('exit 18 (in_use) when a non-DEAD clone runs a mode the package contributes', async () => {
    const localStore = createLocalStore({ homeDir });
    const lockfile = createLockfileStore({ repoRoot });
    await runInstallCommand(makeInstallRuntime(localStore, lockfile), { spec: fixtureTarball });

    // The fixture contributes the library mode `sample-mode` — we forge a
    // clone in WORKING state with mode === 'sample-mode' to simulate a live cast.
    const registry = makeRegistryStub([
      {
        clone_id: 'A',
        state: 'WORKING',
        mode: 'sample-mode',
        metadata: { cast_id: 'cast-123' },
      },
    ]);
    const rt = await makeUninstallRuntime({ localStore, lockfile, registry });
    let caught: unknown;
    try {
      await runUninstallCommand(rt, {
        spec: '@manta-library/sample-package@0.1.0',
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UninstallError);
    expect(caught).toMatchObject({ code: 'uninstall_in_use', exitCode: 18 });
    expect((caught as UninstallError).message).toContain('cast-123');
    expect((caught as UninstallError).message).toContain('A');
    // Install untouched.
    expect(await localStore.isInstalled('@manta-library/sample-package', '0.1.0')).toBe(true);
  });

  it('--force allows uninstall when matched clones are in soft states (IDLE/WAITING_FOR_TASK/WINDING_DOWN)', async () => {
    const localStore = createLocalStore({ homeDir });
    const lockfile = createLockfileStore({ repoRoot });
    await runInstallCommand(makeInstallRuntime(localStore, lockfile), { spec: fixtureTarball });

    const registry = makeRegistryStub([
      {
        clone_id: 'A',
        state: 'IDLE',
        mode: 'sample-mode',
        metadata: { cast_id: 'cast-soft' },
      },
      {
        clone_id: 'B',
        state: 'WAITING_FOR_TASK',
        mode: 'sample-mode',
        metadata: { cast_id: 'cast-soft' },
      },
      {
        clone_id: 'C',
        state: 'WINDING_DOWN',
        mode: 'sample-mode',
        metadata: { cast_id: 'cast-soft' },
      },
    ]);
    const rt = await makeUninstallRuntime({ localStore, lockfile, registry });
    const result = await runUninstallCommand(rt, {
      spec: '@manta-library/sample-package@0.1.0',
      force: true,
    });
    expect(result.removedVersion).toBe('0.1.0');
    expect(await localStore.isInstalled('@manta-library/sample-package', '0.1.0')).toBe(false);
  });

  it('--force REJECTED when any matched clone is in a hot state (STARTING/WORKING/BLOCKED)', async () => {
    const localStore = createLocalStore({ homeDir });
    const lockfile = createLockfileStore({ repoRoot });
    await runInstallCommand(makeInstallRuntime(localStore, lockfile), { spec: fixtureTarball });

    for (const hot of ['STARTING', 'WORKING', 'BLOCKED']) {
      const registry = makeRegistryStub([
        {
          clone_id: 'A',
          state: hot,
          mode: 'sample-mode',
          metadata: { cast_id: `cast-${hot}` },
        },
      ]);
      const rt = await makeUninstallRuntime({ localStore, lockfile, registry });
      let caught: unknown;
      try {
        await runUninstallCommand(rt, {
          spec: '@manta-library/sample-package@0.1.0',
          force: true,
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(UninstallError);
      expect(caught).toMatchObject({ code: 'uninstall_in_use', exitCode: 18 });
      expect((caught as UninstallError).message).toContain('refusing');
      // Install must remain — partial uninstall of a hot-state package corrupts
      // the in-flight cast.
      expect(await localStore.isInstalled('@manta-library/sample-package', '0.1.0')).toBe(true);
    }
  });

  it('ignores DEAD clones during in-use check', async () => {
    const localStore = createLocalStore({ homeDir });
    const lockfile = createLockfileStore({ repoRoot });
    await runInstallCommand(makeInstallRuntime(localStore, lockfile), { spec: fixtureTarball });

    const registry = makeRegistryStub([
      {
        clone_id: 'A',
        state: 'DEAD',
        mode: 'sample-mode',
        metadata: { cast_id: 'cast-dead' },
      },
    ]);
    const rt = await makeUninstallRuntime({ localStore, lockfile, registry });
    const result = await runUninstallCommand(rt, {
      spec: '@manta-library/sample-package@0.1.0',
    });
    expect(result.removedVersion).toBe('0.1.0');
  });
});

describe('runUninstallCommand — idempotency', () => {
  it('re-running uninstall after success surfaces uninstall_not_installed', async () => {
    const localStore = createLocalStore({ homeDir });
    const lockfile = createLockfileStore({ repoRoot });
    await runInstallCommand(makeInstallRuntime(localStore, lockfile), { spec: fixtureTarball });

    const rt = await makeUninstallRuntime({
      localStore,
      lockfile,
      registry: makeRegistryStub([]),
    });
    await runUninstallCommand(rt, { spec: '@manta-library/sample-package@0.1.0' });
    await expect(
      runUninstallCommand(rt, { spec: '@manta-library/sample-package@0.1.0' }),
    ).rejects.toMatchObject({
      code: 'uninstall_not_installed',
      exitCode: 12,
    });
  });
});
