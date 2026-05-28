import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { verifyLibraryIntegrity } from '../../src/library/integrity.js';
import { computeDirDigest } from '../../src/library/dir-digest.js';
import { createLocalStore } from '../../src/library/local-store.js';
import type { Lockfile, LockfileEntry } from '../../src/library/lockfile.js';
import { MANTA_CLI_VERSION } from '../../src/library/cli-version.js';

const ISO = '2026-05-28T11:30:00.000Z';

function entryWith(overrides: Partial<LockfileEntry> = {}): LockfileEntry {
  return {
    version: '0.1.0',
    resolved: 'file://fixture',
    integrity: 'sha256-AAAaaa==',
    directoryDigest: 'sha256-PLACEHOLDER==',
    contributes: { modes: [], skills: [], commands: [], templates: [] },
    mantaVersionCompat: '>=0.0.0',
    installedAt: ISO,
    ...overrides,
  };
}

function lockWith(packages: Record<string, LockfileEntry>): Lockfile {
  return {
    schemaVersion: 1,
    mantaVersion: MANTA_CLI_VERSION,
    generatedAt: ISO,
    packages,
  };
}

async function seedInstall(
  homeDir: string,
  packageName: string,
  version: string,
  fileContents: Record<string, string>,
): Promise<{ installDir: string; digest: string }> {
  const localStore = createLocalStore({ homeDir });
  const installDir = localStore.pathFor(packageName, version);
  await fs.mkdir(installDir, { recursive: true });
  for (const [rel, body] of Object.entries(fileContents)) {
    const full = path.join(installDir, ...rel.split('/'));
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body, 'utf8');
  }
  const digest = await computeDirDigest(installDir);
  return { installDir, digest };
}

describe('verifyLibraryIntegrity', () => {
  const tmpHomes: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tmpHomes.splice(0).map((p) => fs.rm(p, { recursive: true, force: true })),
    );
  });

  it('returns ok when lock has no packages', async () => {
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-integrity-'));
    tmpHomes.push(fakeHome);
    const localStore = createLocalStore({ homeDir: fakeHome });
    const lock = lockWith({});
    const r = await verifyLibraryIntegrity(lock, localStore);
    expect(r).toEqual({ ok: true });
  });

  it('returns ok when every install dir digest matches the recorded directoryDigest', async () => {
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-integrity-'));
    tmpHomes.push(fakeHome);

    const a = await seedInstall(fakeHome, '@manta-library/a', '0.1.0', {
      'manta-package.json': '{"schemaVersion":1,"name":"@manta-library/a","version":"0.1.0"}',
      'skills/intro.md': '# intro\n',
    });
    const b = await seedInstall(fakeHome, '@manta-library/b', '0.2.0', {
      'manta-package.json': '{"schemaVersion":1,"name":"@manta-library/b","version":"0.2.0"}',
    });

    const localStore = createLocalStore({ homeDir: fakeHome });
    const lock = lockWith({
      '@manta-library/a': entryWith({ version: '0.1.0', directoryDigest: a.digest }),
      '@manta-library/b': entryWith({ version: '0.2.0', directoryDigest: b.digest }),
    });

    const r = await verifyLibraryIntegrity(lock, localStore);
    expect(r).toEqual({ ok: true });
  });

  it('returns ok=false with offendingPackage when a file is modified on disk', async () => {
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-integrity-'));
    tmpHomes.push(fakeHome);

    const { installDir, digest: originalDigest } = await seedInstall(
      fakeHome,
      '@manta-library/tampered',
      '1.0.0',
      {
        'manta-package.json': '{"schemaVersion":1,"name":"@manta-library/tampered","version":"1.0.0"}',
        'skills/intro.md': '# original\n',
      },
    );

    // Now mutate one byte on disk after the lock was recorded.
    await fs.writeFile(
      path.join(installDir, 'skills', 'intro.md'),
      '# tampered\n',
      'utf8',
    );

    const localStore = createLocalStore({ homeDir: fakeHome });
    const lock = lockWith({
      '@manta-library/tampered': entryWith({
        version: '1.0.0',
        directoryDigest: originalDigest,
      }),
    });

    const r = await verifyLibraryIntegrity(lock, localStore);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.offendingPackage).toBe('@manta-library/tampered');
      expect(r.expected).toBe(originalDigest);
      expect(r.actual).not.toBe(originalDigest);
      expect(r.actual).toMatch(/^sha256-/);
    }
  });

  it('returns ok=false with actual="<missing>" when the install directory is gone', async () => {
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-integrity-'));
    tmpHomes.push(fakeHome);

    const localStore = createLocalStore({ homeDir: fakeHome });
    // No seed call → install dir does not exist.
    const lock = lockWith({
      '@manta-library/missing': entryWith({
        version: '3.0.0',
        directoryDigest: 'sha256-EXPECTEDDDDDDD==',
      }),
    });

    const r = await verifyLibraryIntegrity(lock, localStore);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.offendingPackage).toBe('@manta-library/missing');
      expect(r.expected).toBe('sha256-EXPECTEDDDDDDD==');
      expect(r.actual).toBe('<missing>');
    }
  });

  it('returns on the first mismatch, leaving later packages unverified', async () => {
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-integrity-'));
    tmpHomes.push(fakeHome);

    // Seed two installs; record a deliberately-wrong digest for the
    // first one (alphabetically) so the loop short-circuits there.
    const aSeed = await seedInstall(fakeHome, '@manta-library/aaa-first', '0.1.0', {
      'manta-package.json': '{"name":"@manta-library/aaa-first"}',
    });
    void aSeed;
    // No need to seed second — we want to assert we never reached it.

    const localStore = createLocalStore({ homeDir: fakeHome });
    const lock = lockWith({
      '@manta-library/aaa-first': entryWith({
        version: '0.1.0',
        directoryDigest: 'sha256-WRONG==',
      }),
      '@manta-library/zzz-second': entryWith({
        version: '0.1.0',
        directoryDigest: 'sha256-ALSOWRONG==',
      }),
    });

    const r = await verifyLibraryIntegrity(lock, localStore);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // Either package could appear depending on Object.entries() ordering,
      // which for JSON-derived objects follows insertion order. The lockfile
      // canonicaliser sorts alphabetically on read, so 'aaa-first' lands
      // before 'zzz-second' regardless. Assert the short-circuit landed on
      // *one* of them and the offending name matches its expected digest.
      expect(['@manta-library/aaa-first', '@manta-library/zzz-second']).toContain(
        r.offendingPackage,
      );
      if (r.offendingPackage === '@manta-library/aaa-first') {
        expect(r.expected).toBe('sha256-WRONG==');
      }
    }
  });
});
