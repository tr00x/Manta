import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildSampleTarball } from '../fixtures/library/build-sample.js';
import { createLockfileStore, type LockfileStore } from '../../src/library/lockfile.js';
import { createLocalStore, type LocalStore } from '../../src/library/local-store.js';
import { createRegistryClient, type NetworkRunner } from '../../src/library/registry-client.js';
import { runInstallCommand, type InstallRuntime } from '../../src/commands/install.js';
import {
  runLibraryListCommand,
  runLibraryShowCommand,
  runLibraryOutdatedCommand,
  runLibraryDoctorCommand,
  LibraryError,
  type LibraryRuntime,
  type LibraryNetworkRunner,
} from '../../src/commands/library.js';

let homeDir: string;
let repoRoot: string;
let fixtureTarball: string;
let fixtureScratchDir: string;

beforeAll(async () => {
  const built = await buildSampleTarball();
  fixtureScratchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-library-fixture-'));
  fixtureTarball = path.join(fixtureScratchDir, 'sample-package.tgz');
  await fs.copyFile(built, fixtureTarball);
});

beforeEach(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-library-home-'));
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-library-repo-'));
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

function makeLibraryRuntime(opts: {
  localStore: LocalStore;
  lockfile: LockfileStore;
  network?: LibraryNetworkRunner;
  mantaCliVersion?: string;
}): LibraryRuntime {
  return {
    repoRoot,
    lockfile: opts.lockfile,
    localStore: opts.localStore,
    network:
      opts.network ?? {
        npmView: () => Promise.reject(new Error('npmView not stubbed')),
      },
    mantaCliVersion: opts.mantaCliVersion ?? '0.7.2',
  };
}

describe('runLibraryListCommand', () => {
  it('returns an empty list and exit 0 on a fresh repo', async () => {
    const localStore = createLocalStore({ homeDir });
    const lockfile = createLockfileStore({ repoRoot });
    const rt = makeLibraryRuntime({ localStore, lockfile });
    const result = await runLibraryListCommand(rt);
    expect(result.exitCode).toBe(0);
    expect(result.installs).toEqual([]);
  });

  it('lists installed packages with contribute counts', async () => {
    const localStore = createLocalStore({ homeDir });
    const lockfile = createLockfileStore({ repoRoot });
    await runInstallCommand(makeInstallRuntime(localStore, lockfile), { spec: fixtureTarball });

    const rt = makeLibraryRuntime({ localStore, lockfile });
    const result = await runLibraryListCommand(rt);
    expect(result.exitCode).toBe(0);
    expect(result.installs).toHaveLength(1);
    expect(result.installs[0]).toMatchObject({
      packageName: '@manta-library/sample-package',
      version: '0.1.0',
      modes: ['sample-mode'],
      skills: ['sample-skill'],
    });
  });
});

describe('runLibraryShowCommand', () => {
  it('returns the install entry for an installed package', async () => {
    const localStore = createLocalStore({ homeDir });
    const lockfile = createLockfileStore({ repoRoot });
    await runInstallCommand(makeInstallRuntime(localStore, lockfile), { spec: fixtureTarball });
    const rt = makeLibraryRuntime({ localStore, lockfile });
    const result = await runLibraryShowCommand(rt, { spec: '@manta-library/sample-package@0.1.0' });
    expect(result.exitCode).toBe(0);
    expect(result.install).toMatchObject({
      packageName: '@manta-library/sample-package',
      version: '0.1.0',
    });
    expect(result.lockEntry).not.toBeNull();
    expect(result.lockEntry!.mantaVersionCompat).toBeDefined();
  });

  it('exit 12 (not_installed) for an unknown package', async () => {
    const localStore = createLocalStore({ homeDir });
    const lockfile = createLockfileStore({ repoRoot });
    const rt = makeLibraryRuntime({ localStore, lockfile });
    await expect(
      runLibraryShowCommand(rt, { spec: '@manta-library/unknown' }),
    ).rejects.toMatchObject({ code: 'library_not_installed', exitCode: 12 });
  });

  it('resolves bare name when exactly one version is installed', async () => {
    const localStore = createLocalStore({ homeDir });
    const lockfile = createLockfileStore({ repoRoot });
    await runInstallCommand(makeInstallRuntime(localStore, lockfile), { spec: fixtureTarball });
    const rt = makeLibraryRuntime({ localStore, lockfile });
    const result = await runLibraryShowCommand(rt, { spec: '@manta-library/sample-package' });
    expect(result.install.version).toBe('0.1.0');
  });
});

describe('runLibraryOutdatedCommand', () => {
  it('reports pinned for git-resolved lockfile entries', async () => {
    const localStore = createLocalStore({ homeDir });
    const lockfile = createLockfileStore({ repoRoot });
    // Install the fixture; lockfile.resolved will be the absolute fixture path.
    await runInstallCommand(makeInstallRuntime(localStore, lockfile), { spec: fixtureTarball });
    // Rewrite the lockfile so the entry looks like a git install.
    await lockfile.mutate((current) => {
      const next = { ...current!, packages: { ...current!.packages } };
      const entry = next.packages['@manta-library/sample-package']!;
      next.packages['@manta-library/sample-package'] = {
        ...entry,
        resolved: 'git+https://github.com/u/r#v0.1.0',
      };
      return next;
    });
    const rt = makeLibraryRuntime({ localStore, lockfile });
    const result = await runLibraryOutdatedCommand(rt);
    expect(result.exitCode).toBe(0);
    expect(result.report).toHaveLength(1);
    expect(result.report[0]!.status).toBe('pinned');
  });

  it('reports outdated when npm view returns a newer version satisfying the range', async () => {
    const localStore = createLocalStore({ homeDir });
    const lockfile = createLockfileStore({ repoRoot });
    await runInstallCommand(makeInstallRuntime(localStore, lockfile), { spec: fixtureTarball });
    // Pretend it was installed from npm so the lockfile.resolved looks npm-ish.
    await lockfile.mutate((current) => {
      const next = { ...current!, packages: { ...current!.packages } };
      const entry = next.packages['@manta-library/sample-package']!;
      next.packages['@manta-library/sample-package'] = {
        ...entry,
        resolved: 'https://registry.npmjs.org/@manta-library/sample-package/-/sample-package-0.1.0.tgz',
        mantaVersionCompat: '>=0.7.0 <1.0.0',
      };
      return next;
    });
    const rt = makeLibraryRuntime({
      localStore,
      lockfile,
      network: {
        npmView: (name: string) => {
          expect(name).toBe('@manta-library/sample-package');
          return Promise.resolve(['0.1.0', '0.2.0']);
        },
      },
    });
    const result = await runLibraryOutdatedCommand(rt);
    expect(result.exitCode).toBe(0);
    expect(result.report).toHaveLength(1);
    expect(result.report[0]).toMatchObject({
      packageName: '@manta-library/sample-package',
      currentVersion: '0.1.0',
      status: 'outdated',
      latestSatisfying: '0.2.0',
    });
  });

  it('exit 0 even when the lockfile is empty', async () => {
    const localStore = createLocalStore({ homeDir });
    const lockfile = createLockfileStore({ repoRoot });
    const rt = makeLibraryRuntime({ localStore, lockfile });
    const result = await runLibraryOutdatedCommand(rt);
    expect(result.exitCode).toBe(0);
    expect(result.report).toEqual([]);
  });
});

describe('runLibraryDoctorCommand', () => {
  it('exit 0 when every installed package passes validatePackage', async () => {
    const localStore = createLocalStore({ homeDir });
    const lockfile = createLockfileStore({ repoRoot });
    await runInstallCommand(makeInstallRuntime(localStore, lockfile), { spec: fixtureTarball });
    const rt = makeLibraryRuntime({ localStore, lockfile });
    const result = await runLibraryDoctorCommand(rt);
    expect(result.exitCode).toBe(0);
    expect(result.healthy).toHaveLength(1);
    expect(result.unhealthy).toEqual([]);
  });

  it('exit 20 (library_unhealthy) when a package fails mantaVersionCompat after a CLI upgrade', async () => {
    const localStore = createLocalStore({ homeDir });
    const lockfile = createLockfileStore({ repoRoot });
    await runInstallCommand(makeInstallRuntime(localStore, lockfile), { spec: fixtureTarball });
    // Simulate CLI upgrade: bump mantaCliVersion to something outside the
    // fixture's `>=0.7.0 <1.0.0` range.
    const rt = makeLibraryRuntime({
      localStore,
      lockfile,
      mantaCliVersion: '2.0.0',
    });
    let caught: unknown;
    try {
      await runLibraryDoctorCommand(rt);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LibraryError);
    expect(caught).toMatchObject({ code: 'library_unhealthy', exitCode: 20 });
    expect((caught as LibraryError).details.unhealthy).toBeDefined();
  });

  it('exit 20 when an installed package is missing from disk', async () => {
    const localStore = createLocalStore({ homeDir });
    const lockfile = createLockfileStore({ repoRoot });
    await runInstallCommand(makeInstallRuntime(localStore, lockfile), { spec: fixtureTarball });
    // Wipe the install dir but leave the index entry — simulates rm -rf ~/.manta/library.
    await fs.rm(localStore.pathFor('@manta-library/sample-package', '0.1.0'), {
      recursive: true,
      force: true,
    });
    const rt = makeLibraryRuntime({ localStore, lockfile });
    await expect(runLibraryDoctorCommand(rt)).rejects.toMatchObject({
      code: 'library_unhealthy',
      exitCode: 20,
    });
  });
});
