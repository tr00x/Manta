import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createLocalStore,
  type GlobalLibraryIndexEntry,
} from '../../src/library/local-store.js';
import { computeDirDigest } from '../../src/library/dir-digest.js';

let homeDir: string;
let sourceDir: string;

beforeEach(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-local-store-home-'));
  sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-local-store-src-'));
});

afterEach(async () => {
  await fs.rm(homeDir, { recursive: true, force: true });
  await fs.rm(sourceDir, { recursive: true, force: true });
});

async function writeUnpackedSample(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'manta-package.json'), JSON.stringify({ name: 'sample', version: '1.0.0' }));
  await fs.mkdir(path.join(dir, 'skills'), { recursive: true });
  await fs.writeFile(path.join(dir, 'skills', 'sample-skill.md'), '# sample');
}

const sampleEntry = (overrides: Partial<GlobalLibraryIndexEntry> = {}): GlobalLibraryIndexEntry => ({
  packageName: '@manta-library/sample',
  version: '1.0.0',
  path: '/Users/x/.manta/library/@manta-library/sample/1.0.0',
  contributes: { modes: [], skills: ['sample-skill'], commands: [], templates: [] },
  installedAt: '2026-05-28T11:30:00.000Z',
  integrity: 'sha256-AAAaaaa==',
  ...overrides,
});

describe('LocalStore', () => {
  it('root reflects the library directory under the supplied homeDir', () => {
    const store = createLocalStore({ homeDir });
    expect(store.root).toBe(path.join(homeDir, '.manta', 'library'));
  });

  it('readIndex() on a fresh homeDir returns an empty index', async () => {
    const store = createLocalStore({ homeDir });
    const idx = await store.readIndex();
    expect(idx.schemaVersion).toBe(1);
    expect(idx.installs).toEqual([]);
    expect(typeof idx.updatedAt).toBe('string');
  });

  it('pathFor returns the canonical install path for a scoped name', () => {
    const store = createLocalStore({ homeDir });
    const p = store.pathFor('@manta-library/sample', '1.0.0');
    expect(p).toBe(path.join(homeDir, '.manta', 'library', '@manta-library', 'sample', '1.0.0'));
  });

  it('pathFor returns the canonical install path for a bare name', () => {
    const store = createLocalStore({ homeDir });
    const p = store.pathFor('sample', '1.0.0');
    expect(p).toBe(path.join(homeDir, '.manta', 'library', 'sample', '1.0.0'));
  });

  it('isInstalled returns true after commit and false before', async () => {
    const store = createLocalStore({ homeDir });
    await writeUnpackedSample(sourceDir);
    expect(await store.isInstalled('@manta-library/sample', '1.0.0')).toBe(false);
    const staged = await store.stage({ unpackedTarballDir: sourceDir });
    const { finalDir } = await staged.commit({ packageName: '@manta-library/sample', version: '1.0.0' });
    expect(await store.isInstalled('@manta-library/sample', '1.0.0')).toBe(true);
    expect(finalDir).toBe(store.pathFor('@manta-library/sample', '1.0.0'));
  });

  it('two parallel stage() calls produce distinct staging dirs', async () => {
    const store = createLocalStore({ homeDir });
    await writeUnpackedSample(sourceDir);
    const [a, b] = await Promise.all([
      store.stage({ unpackedTarballDir: sourceDir }),
      store.stage({ unpackedTarballDir: sourceDir }),
    ]);
    expect(a.stagingDir).not.toBe(b.stagingDir);
    await a.discard();
    await b.discard();
  });

  it('commit() rejects when the final dir already exists (collision)', async () => {
    const store = createLocalStore({ homeDir });
    await writeUnpackedSample(sourceDir);
    const staged1 = await store.stage({ unpackedTarballDir: sourceDir });
    await staged1.commit({ packageName: '@manta-library/sample', version: '1.0.0' });

    const staged2 = await store.stage({ unpackedTarballDir: sourceDir });
    await expect(staged2.commit({ packageName: '@manta-library/sample', version: '1.0.0' })).rejects.toMatchObject({
      code: 'collision',
    });
    await staged2.discard();
  });

  it('discard() removes the staging dir', async () => {
    const store = createLocalStore({ homeDir });
    await writeUnpackedSample(sourceDir);
    const staged = await store.stage({ unpackedTarballDir: sourceDir });
    expect(await dirExists(staged.stagingDir)).toBe(true);
    await staged.discard();
    expect(await dirExists(staged.stagingDir)).toBe(false);
  });

  it('discard() is idempotent', async () => {
    const store = createLocalStore({ homeDir });
    await writeUnpackedSample(sourceDir);
    const staged = await store.stage({ unpackedTarballDir: sourceDir });
    await staged.discard();
    await expect(staged.discard()).resolves.toBeUndefined();
  });

  it('upsertIndexEntry adds, then later replaces, a same-name entry', async () => {
    const store = createLocalStore({ homeDir });
    await store.upsertIndexEntry(sampleEntry({ version: '1.0.0' }));
    let idx = await store.readIndex();
    expect(idx.installs).toHaveLength(1);

    await store.upsertIndexEntry(sampleEntry({ version: '1.1.0' }));
    idx = await store.readIndex();
    // Different versions coexist.
    expect(idx.installs).toHaveLength(2);

    await store.upsertIndexEntry(sampleEntry({ version: '1.0.0', integrity: 'sha256-NEWAaa==' }));
    idx = await store.readIndex();
    expect(idx.installs.filter((e) => e.version === '1.0.0' && e.packageName === sampleEntry().packageName)).toHaveLength(1);
    expect(idx.installs.find((e) => e.version === '1.0.0')?.integrity).toBe('sha256-NEWAaa==');
  });

  it('removeIndexEntry drops a matching entry and is a no-op when missing', async () => {
    const store = createLocalStore({ homeDir });
    await store.upsertIndexEntry(sampleEntry());
    await store.removeIndexEntry('@manta-library/sample', '1.0.0');
    const idx = await store.readIndex();
    expect(idx.installs).toEqual([]);

    await expect(store.removeIndexEntry('@manta-library/nope', '0.0.1')).resolves.toBeUndefined();
  });
});

describe('computeDirDigest', () => {
  it('returns a stable sha256- prefixed digest for the same on-disk content', async () => {
    await writeUnpackedSample(sourceDir);
    const a = await computeDirDigest(sourceDir);
    const b = await computeDirDigest(sourceDir);
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256-/);
  });

  it('changes when content changes', async () => {
    await writeUnpackedSample(sourceDir);
    const a = await computeDirDigest(sourceDir);
    await fs.writeFile(path.join(sourceDir, 'skills', 'sample-skill.md'), '# different');
    const b = await computeDirDigest(sourceDir);
    expect(a).not.toBe(b);
  });

  it('changes when a file is added', async () => {
    await writeUnpackedSample(sourceDir);
    const a = await computeDirDigest(sourceDir);
    await fs.writeFile(path.join(sourceDir, 'NEWFILE'), 'present');
    const b = await computeDirDigest(sourceDir);
    expect(a).not.toBe(b);
  });
});

async function dirExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
