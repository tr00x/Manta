import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { buildSampleTarball } from '../fixtures/library/build-sample.js';
import { createLockfileStore } from '../../src/library/lockfile.js';
import { createLocalStore } from '../../src/library/local-store.js';
import { createRegistryClient, type NetworkRunner } from '../../src/library/registry-client.js';
import {
  runInstallCommand,
  type InstallRuntime,
  InstallError,
} from '../../src/commands/install.js';

let homeDir: string;
let repoRoot: string;
let fixtureTarball: string;
let fixtureScratchDir: string;

beforeAll(async () => {
  // buildSampleTarball() writes to a fixed shared path; registry-client.test.ts
  // also rebuilds it. Vitest runs test files in parallel worker threads, so two
  // simultaneous rebuilds race and one reader can see a partially-written file.
  // Copy the result to a per-suite path before any tests touch it.
  const built = await buildSampleTarball();
  fixtureScratchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-install-fixture-'));
  fixtureTarball = path.join(fixtureScratchDir, 'sample-package.tgz');
  await fs.copyFile(built, fixtureTarball);
});

beforeEach(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-install-home-'));
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-install-repo-'));
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

function makeInstallRuntime(
  opts: { mantaCliVersion?: string; offline?: boolean } = {},
): InstallRuntime {
  const lockfile = createLockfileStore({ repoRoot });
  const localStore = createLocalStore({ homeDir });
  const registryClient = createRegistryClient({
    runner: stubNetworkRunner(),
    ...(opts.offline ? { offline: true } : {}),
  });
  return {
    repoRoot,
    lockfile,
    localStore,
    registryClient,
    mantaCliVersion: opts.mantaCliVersion ?? '0.7.2',
  };
}

function hexToB64(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64');
}

describe('runInstallCommand — happy path', () => {
  it('installs a local fixture tgz end-to-end', async () => {
    const rt = makeInstallRuntime();
    const result = await runInstallCommand(rt, { spec: fixtureTarball });

    expect(result.packageName).toBe('@manta-library/sample-package');
    expect(result.version).toBe('0.1.0');
    expect(result.contributedModes).toEqual(['sample-mode']);
    expect(result.contributedSkills).toBe(1);

    expect(await rt.localStore.isInstalled(result.packageName, result.version)).toBe(true);
    const idx = await rt.localStore.readIndex();
    expect(idx.installs).toHaveLength(1);
    expect(idx.installs[0]!.integrity).toMatch(/^sha256-/);

    const lock = await rt.lockfile.read();
    expect(lock).not.toBeNull();
    expect(Object.keys(lock!.packages)).toEqual(['@manta-library/sample-package']);
    const entry = lock!.packages['@manta-library/sample-package']!;
    expect(entry.version).toBe('0.1.0');
    expect(entry.integrity).toMatch(/^sha256-/);
    expect(entry.directoryDigest).toMatch(/^sha256-/);
    expect(entry.contributes.modes).toEqual(['sample-mode']);
  });
});

describe('runInstallCommand — error paths', () => {
  it('rejects an unparseable spec with install_spec_parse_failed', async () => {
    const rt = makeInstallRuntime();
    await expect(runInstallCommand(rt, { spec: 'not a package' })).rejects.toMatchObject({
      code: 'install_spec_parse_failed',
      exitCode: 11,
    });
  });

  it('rejects a manta-version-incompatible package with install_compat_unmet', async () => {
    const rt = makeInstallRuntime({ mantaCliVersion: '0.5.0' });
    await expect(runInstallCommand(rt, { spec: fixtureTarball })).rejects.toMatchObject({
      code: 'install_compat_unmet',
      exitCode: 16,
    });
  });

  it('rejects a duplicate install with install_already_installed', async () => {
    const rt = makeInstallRuntime();
    await runInstallCommand(rt, { spec: fixtureTarball });
    await expect(runInstallCommand(rt, { spec: fixtureTarball })).rejects.toMatchObject({
      code: 'install_already_installed',
      exitCode: 15,
    });
    // First install untouched.
    expect(await rt.localStore.isInstalled('@manta-library/sample-package', '0.1.0')).toBe(true);
  });

  it('rejects a package failing validation with install_validation_failed', async () => {
    // Use the drive-by-skill fixture under skill-validator's tests, packaged on the fly.
    const tmpSource = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-install-bad-src-'));
    try {
      // Build a fixture with a manifest declaring sample-skill plus a sneaky undeclared skill.
      await fs.writeFile(
        path.join(tmpSource, 'manta-package.json'),
        JSON.stringify({
          schemaVersion: 1,
          name: '@manta-library/bad-package',
          version: '0.1.0',
          description: 'Bad package — ships a drive-by skill the manifest does not declare.',
          author: 'test',
          license: 'MIT',
          mantaVersionCompat: '>=0.7.0 <1.0.0',
          contributes: {
            skills: [{ name: 'declared', description: 'Declared skill that exists on disk.' }],
          },
        }),
      );
      await fs.mkdir(path.join(tmpSource, 'skills', 'declared'), { recursive: true });
      await fs.writeFile(
        path.join(tmpSource, 'skills', 'declared', 'SKILL.md'),
        `---\nname: declared\ndescription: Declared skill that exists on disk in bad fixture\naudience: clone\nversion: 0.1.0\nrelated: []\n---\n\n# declared\n\n## Purpose\n\nx\n\n## Allowed\n\nx\n\n## Forbidden\n\nx\n\n## Examples\n\nx\n`,
      );
      await fs.mkdir(path.join(tmpSource, 'skills', 'sneaky'), { recursive: true });
      await fs.writeFile(
        path.join(tmpSource, 'skills', 'sneaky', 'SKILL.md'),
        `---\nname: sneaky\ndescription: Undeclared drive-by skill — validatePackage must reject\naudience: clone\nversion: 0.1.0\nrelated: []\n---\n\n# sneaky\n\n## Purpose\n\nx\n\n## Allowed\n\nx\n\n## Forbidden\n\nx\n\n## Examples\n\nx\n`,
      );
      const tar = await import('tar');
      const tarPath = path.join(tmpSource, 'bad.tgz');
      await tar.c(
        { file: tarPath, cwd: tmpSource, gzip: true, portable: true, noMtime: true },
        ['manta-package.json', 'skills'],
      );
      const rt = makeInstallRuntime();
      await expect(runInstallCommand(rt, { spec: tarPath })).rejects.toMatchObject({
        code: 'install_validation_failed',
        exitCode: 14,
      });
      expect(await rt.localStore.isInstalled('@manta-library/bad-package', '0.1.0')).toBe(false);
    } finally {
      await fs.rm(tmpSource, { recursive: true, force: true });
    }
  });

  it('exposes InstallError as the thrown type', async () => {
    const rt = makeInstallRuntime();
    let caught: unknown;
    try {
      await runInstallCommand(rt, { spec: 'not a package' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InstallError);
  });
});

describe('runInstallCommand — --force', () => {
  it('overwrites an existing same-version install', async () => {
    const rt = makeInstallRuntime();
    await runInstallCommand(rt, { spec: fixtureTarball });
    const installPath = rt.localStore.pathFor('@manta-library/sample-package', '0.1.0');
    const markerPath = path.join(installPath, '.user-modified.txt');
    await fs.writeFile(markerPath, 'should-be-gone');

    const result = await runInstallCommand(rt, { spec: fixtureTarball, force: true });
    expect(result.version).toBe('0.1.0');
    await expect(fs.access(markerPath)).rejects.toBeDefined();
    expect(await rt.localStore.isInstalled(result.packageName, result.version)).toBe(true);
  });

  it('without --force still rejects existing install with exit 15', async () => {
    const rt = makeInstallRuntime();
    await runInstallCommand(rt, { spec: fixtureTarball });
    await expect(runInstallCommand(rt, { spec: fixtureTarball })).rejects.toMatchObject({
      code: 'install_already_installed',
      exitCode: 15,
    });
  });
});

describe('runInstallCommand — --offline', () => {
  it('allows local-tgz spec under --offline', async () => {
    const rt = makeInstallRuntime({ offline: true });
    const result = await runInstallCommand(rt, { spec: fixtureTarball, offline: true });
    expect(result.packageName).toBe('@manta-library/sample-package');
  });

  it('rejects npm spec under --offline with install_network_required_for_spec_kind (exit 11)', async () => {
    const rt = makeInstallRuntime({ offline: true });
    await expect(
      runInstallCommand(rt, { spec: '@manta-library/sample-package@^0.1.0', offline: true }),
    ).rejects.toMatchObject({
      code: 'install_network_required_for_spec_kind',
      exitCode: 11,
    });
  });

  it('rejects git spec under --offline with install_network_required_for_spec_kind', async () => {
    const rt = makeInstallRuntime({ offline: true });
    await expect(
      runInstallCommand(rt, { spec: 'git+https://github.com/u/r#v0.1.0', offline: true }),
    ).rejects.toMatchObject({
      code: 'install_network_required_for_spec_kind',
      exitCode: 11,
    });
  });
});

describe('runInstallCommand — --integrity', () => {
  it('accepts a matching user-pinned sha256-<base64> hash', async () => {
    const rt = makeInstallRuntime();
    const buf = await fs.readFile(fixtureTarball);
    const hex = crypto.createHash('sha256').update(buf).digest('hex');
    const expected = `sha256-${hexToB64(hex)}`;
    const result = await runInstallCommand(rt, { spec: fixtureTarball, integrity: expected });
    expect(result.version).toBe('0.1.0');
  });

  it('rejects a mismatching --integrity with install_checksum_mismatch (exit 13)', async () => {
    const rt = makeInstallRuntime();
    const bogus = `sha256-${hexToB64('0'.repeat(64))}`;
    let caught: unknown;
    try {
      await runInstallCommand(rt, { spec: fixtureTarball, integrity: bogus });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InstallError);
    expect(caught).toMatchObject({
      code: 'install_checksum_mismatch',
      exitCode: 13,
    });
    // Error message lists both values so the operator can see the drift.
    const msg = (caught as InstallError).message;
    expect(msg).toContain('expected');
    expect(msg).toContain('actual');
    expect(msg).toContain(bogus);
    // Nothing left on disk.
    expect(await rt.localStore.isInstalled('@manta-library/sample-package', '0.1.0')).toBe(false);
  });
});

describe('runInstallCommand — --dry-run', () => {
  it('returns a valid result but does not modify disk', async () => {
    const rt = makeInstallRuntime();
    const result = await runInstallCommand(rt, { spec: fixtureTarball, dryRun: true });
    expect(result.packageName).toBe('@manta-library/sample-package');
    expect(result.version).toBe('0.1.0');
    expect(result.contributedModes).toEqual(['sample-mode']);

    expect(await rt.localStore.isInstalled(result.packageName, result.version)).toBe(false);
    const lock = await rt.lockfile.read();
    expect(lock).toBeNull();
    const idx = await rt.localStore.readIndex();
    expect(idx.installs).toEqual([]);
  });

  it('a real install after a successful --dry-run still succeeds', async () => {
    const rt = makeInstallRuntime();
    await runInstallCommand(rt, { spec: fixtureTarball, dryRun: true });
    const result = await runInstallCommand(rt, { spec: fixtureTarball });
    expect(await rt.localStore.isInstalled(result.packageName, result.version)).toBe(true);
  });
});

describe('runInstallCommand — --no-validate', () => {
  it('installs the sample fixture without running validatePackage', async () => {
    const rt = makeInstallRuntime();
    const result = await runInstallCommand(rt, { spec: fixtureTarball, noValidate: true });
    expect(result.packageName).toBe('@manta-library/sample-package');
    expect(await rt.localStore.isInstalled(result.packageName, result.version)).toBe(true);
  });

  it('still rejects manifest schema violations even under --no-validate', async () => {
    const tmpSource = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-novalidate-bad-'));
    try {
      // Manifest missing required fields (no `name`, no `version`).
      await fs.writeFile(
        path.join(tmpSource, 'manta-package.json'),
        JSON.stringify({ schemaVersion: 1, mantaVersionCompat: '>=0.7.0 <1.0.0' }),
      );
      const tar = await import('tar');
      const tarPath = path.join(tmpSource, 'bad.tgz');
      await tar.c(
        { file: tarPath, cwd: tmpSource, gzip: true, portable: true, noMtime: true },
        ['manta-package.json'],
      );
      const rt = makeInstallRuntime();
      await expect(
        runInstallCommand(rt, { spec: tarPath, noValidate: true }),
      ).rejects.toMatchObject({
        code: 'install_manifest_invalid',
        exitCode: 14,
      });
    } finally {
      await fs.rm(tmpSource, { recursive: true, force: true });
    }
  });
});
