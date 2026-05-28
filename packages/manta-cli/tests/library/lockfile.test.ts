import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  LockfileSchema,
  ManifestLockEntrySchema,
  createLockfileStore,
  type Lockfile,
  type LockfileEntry,
} from '../../src/library/lockfile.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-lockfile-test-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const sampleEntry = (overrides: Partial<LockfileEntry> = {}): LockfileEntry => ({
  version: '1.3.0',
  resolved: 'https://registry.npmjs.org/@manta-library/refactor-megapack/-/refactor-megapack-1.3.0.tgz',
  integrity: 'sha256-Y2FjAaaa11223344==',
  directoryDigest: 'sha256-DDDDaaaa11223344==',
  contributes: { modes: ['mega-refactor'], skills: [], commands: [], templates: [] },
  mantaVersionCompat: '>=0.7.0 <1.0.0',
  installedAt: '2026-05-28T11:30:00.000Z',
  ...overrides,
});

const sampleLock = (): Lockfile => ({
  schemaVersion: 1,
  mantaVersion: '0.7.2',
  generatedAt: '2026-05-28T11:30:00.000Z',
  packages: {
    '@manta-library/refactor-megapack': sampleEntry(),
  },
});

describe('LockfileSchema', () => {
  it('parses a well-formed lockfile', () => {
    const r = LockfileSchema.safeParse(sampleLock());
    expect(r.success).toBe(true);
  });

  it('rejects unknown top-level fields (.strict)', () => {
    const r = LockfileSchema.safeParse({ ...sampleLock(), bogus: 'field' });
    expect(r.success).toBe(false);
  });

  it('rejects unknown fields on a lock entry (.strict)', () => {
    const r = LockfileSchema.safeParse({
      ...sampleLock(),
      packages: {
        '@manta-library/refactor-megapack': { ...sampleEntry(), surprise: 'no' },
      },
    });
    expect(r.success).toBe(false);
  });

  it('requires integrity to have sha256- prefix', () => {
    const r = ManifestLockEntrySchema.safeParse({ ...sampleEntry(), integrity: 'sha1-broken' });
    expect(r.success).toBe(false);
  });

  it('requires directoryDigest to have sha256- prefix', () => {
    const r = ManifestLockEntrySchema.safeParse({ ...sampleEntry(), directoryDigest: 'plain-text' });
    expect(r.success).toBe(false);
  });
});

describe('createLockfileStore — read/write', () => {
  it('read() returns null on a fresh repo (no manta-lock.json)', async () => {
    const store = createLockfileStore({ repoRoot: tmp });
    const r = await store.read();
    expect(r).toBeNull();
  });

  it('write() persists a lockfile that round-trips through read()', async () => {
    const store = createLockfileStore({ repoRoot: tmp });
    await store.write(sampleLock());
    const r = await store.read();
    expect(r).toEqual(sampleLock());
  });

  it('write() produces deterministic bytes — two writes of the same content are byte-identical', async () => {
    const store = createLockfileStore({ repoRoot: tmp });
    const lock = sampleLock();
    await store.write(lock);
    const first = await fs.readFile(store.path);
    await store.write(lock);
    const second = await fs.readFile(store.path);
    expect(first.equals(second)).toBe(true);
  });

  it('write() produces alphabetically-sorted package keys', async () => {
    const store = createLockfileStore({ repoRoot: tmp });
    const lock: Lockfile = {
      ...sampleLock(),
      packages: {
        '@manta-library/z-pack': sampleEntry(),
        '@manta-library/a-pack': sampleEntry(),
        '@manta-library/m-pack': sampleEntry(),
      },
    };
    await store.write(lock);
    const raw = await fs.readFile(store.path, 'utf8');
    const aIdx = raw.indexOf('a-pack');
    const mIdx = raw.indexOf('m-pack');
    const zIdx = raw.indexOf('z-pack');
    expect(aIdx).toBeGreaterThan(0);
    expect(mIdx).toBeGreaterThan(aIdx);
    expect(zIdx).toBeGreaterThan(mIdx);
  });

  it('write() emits two-space indent and trailing newline', async () => {
    const store = createLockfileStore({ repoRoot: tmp });
    await store.write(sampleLock());
    const raw = await fs.readFile(store.path, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toMatch(/\n  "/);
  });

  it('write() rejects invalid lockfile shape early (does not write a bad file)', async () => {
    const store = createLockfileStore({ repoRoot: tmp });
    const bad = { ...sampleLock(), schemaVersion: 99 } as unknown as Lockfile;
    await expect(store.write(bad)).rejects.toThrow();
    await expect(fs.access(store.path)).rejects.toThrow();
  });
});

describe('LockfileStore.mutate', () => {
  it('mutate() initialises a fresh lockfile when the file is missing', async () => {
    const store = createLockfileStore({ repoRoot: tmp });
    const r = await store.mutate(() => sampleLock());
    expect(r).toEqual(sampleLock());
    const reread = await store.read();
    expect(reread).toEqual(sampleLock());
  });

  it('mutate() passes the current state to the callback', async () => {
    const store = createLockfileStore({ repoRoot: tmp });
    await store.write(sampleLock());
    let seen: Lockfile | null = null;
    await store.mutate((current) => {
      seen = current;
      return current!;
    });
    expect(seen).toEqual(sampleLock());
  });

  it('concurrent mutate() calls all succeed and the final state contains every contribution', async () => {
    const store = createLockfileStore({ repoRoot: tmp });
    const ops = Array.from({ length: 10 }, (_, i) => i);
    await Promise.all(
      ops.map((i) =>
        store.mutate((current) => {
          const base: Lockfile = current ?? {
            schemaVersion: 1,
            mantaVersion: '0.7.2',
            generatedAt: '2026-05-28T11:30:00.000Z',
            packages: {},
          };
          return {
            ...base,
            packages: {
              ...base.packages,
              [`@manta-library/pkg-${i}`]: sampleEntry(),
            },
          };
        }),
      ),
    );
    const final = await store.read();
    expect(Object.keys(final!.packages)).toHaveLength(10);
  });
});
