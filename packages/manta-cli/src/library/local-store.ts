import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { atomicMutateJson, atomicReadJson } from '@manta/bus';

const SHA256_BASE64 = /^sha256-[A-Za-z0-9+/=]+$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

const GlobalLibraryIndexEntrySchema = z
  .object({
    packageName: z.string().min(1),
    version: z.string().regex(SEMVER, 'version must be semver'),
    path: z.string().min(1),
    contributes: z
      .object({
        modes: z.array(z.string()),
        skills: z.array(z.string()),
        commands: z.array(z.string()),
        templates: z.array(z.string()),
      })
      .strict(),
    installedAt: z.string().regex(ISO_8601, 'installedAt must be ISO-8601'),
    integrity: z.string().regex(SHA256_BASE64, 'integrity must be sha256-<base64>'),
  })
  .strict();

const GlobalLibraryIndexSchema = z
  .object({
    schemaVersion: z.literal(1),
    updatedAt: z.string().regex(ISO_8601, 'updatedAt must be ISO-8601'),
    installs: z.array(GlobalLibraryIndexEntrySchema),
  })
  .strict();

export type GlobalLibraryIndexEntry = z.infer<typeof GlobalLibraryIndexEntrySchema>;
export type GlobalLibraryIndex = z.infer<typeof GlobalLibraryIndexSchema>;

export interface CommitArgs {
  packageName: string;
  version: string;
}

export interface StagedPackage {
  readonly stagingDir: string;
  commit(args: CommitArgs): Promise<{ finalDir: string }>;
  discard(): Promise<void>;
}

export interface LocalStore {
  readonly root: string;
  stage(opts: { unpackedTarballDir: string }): Promise<StagedPackage>;
  readIndex(): Promise<GlobalLibraryIndex>;
  upsertIndexEntry(entry: GlobalLibraryIndexEntry): Promise<void>;
  removeIndexEntry(packageName: string, version: string): Promise<void>;
  pathFor(packageName: string, version: string): string;
  isInstalled(packageName: string, version: string): Promise<boolean>;
}

export type LocalStoreErrorCode = 'collision' | 'invalid_input';

export class LocalStoreError extends Error {
  readonly code: LocalStoreErrorCode;
  readonly details: Record<string, unknown>;
  constructor(code: LocalStoreErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'LocalStoreError';
    this.code = code;
    this.details = details;
  }
}

export interface CreateLocalStoreOptions {
  homeDir?: string;
}

async function copyTree(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const sp = path.join(src, e.name);
    const dp = path.join(dest, e.name);
    if (e.isDirectory()) {
      await copyTree(sp, dp);
    } else if (e.isFile()) {
      await fs.copyFile(sp, dp);
    }
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function splitPackagePath(packageName: string): string[] {
  if (packageName.startsWith('@')) {
    const [scope, name] = packageName.split('/');
    if (!scope || !name) {
      throw new LocalStoreError('invalid_input', `invalid scoped package name: ${packageName}`);
    }
    return [scope, name];
  }
  return [packageName];
}

export function createLocalStore(opts: CreateLocalStoreOptions = {}): LocalStore {
  const home = opts.homeDir ?? os.homedir();
  const root = path.join(home, '.manta', 'library');
  const stagingRoot = path.join(root, '.staging');
  const indexPath = path.join(root, 'index.json');

  function pathFor(packageName: string, version: string): string {
    return path.join(root, ...splitPackagePath(packageName), version);
  }

  async function isInstalled(packageName: string, version: string): Promise<boolean> {
    return pathExists(pathFor(packageName, version));
  }

  async function stage(stageOpts: { unpackedTarballDir: string }): Promise<StagedPackage> {
    await fs.mkdir(stagingRoot, { recursive: true });
    const stagingDir = await fs.mkdtemp(path.join(stagingRoot, 'pkg-'));
    await copyTree(stageOpts.unpackedTarballDir, stagingDir);

    let settled = false;

    const commit: StagedPackage['commit'] = async ({ packageName, version }) => {
      if (settled) throw new LocalStoreError('invalid_input', 'stage already settled');
      const finalDir = pathFor(packageName, version);
      if (await pathExists(finalDir)) {
        throw new LocalStoreError('collision', `${packageName}@${version} already installed at ${finalDir}`, {
          packageName,
          version,
          path: finalDir,
        });
      }
      await fs.mkdir(path.dirname(finalDir), { recursive: true });
      await fs.rename(stagingDir, finalDir);
      settled = true;
      return { finalDir };
    };

    const discard: StagedPackage['discard'] = async () => {
      if (settled) return;
      await fs.rm(stagingDir, { recursive: true, force: true });
      settled = true;
    };

    return { stagingDir, commit, discard };
  }

  async function readIndex(): Promise<GlobalLibraryIndex> {
    const parsed = await atomicReadJson<unknown>(indexPath, () => ({
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      installs: [],
    }));
    const r = GlobalLibraryIndexSchema.safeParse(parsed);
    if (!r.success) {
      throw new Error(`~/.manta/library/index.json failed validation: ${r.error.issues.map((i) => i.message).join('; ')}`);
    }
    return r.data;
  }

  async function upsertIndexEntry(entry: GlobalLibraryIndexEntry): Promise<void> {
    GlobalLibraryIndexEntrySchema.parse(entry);
    await atomicMutateJson<GlobalLibraryIndex>(
      indexPath,
      () => ({ schemaVersion: 1 as const, updatedAt: new Date().toISOString(), installs: [] }),
      (current) => {
        const next = { ...current };
        const others = current.installs.filter(
          (e) => !(e.packageName === entry.packageName && e.version === entry.version),
        );
        next.installs = [...others, entry].sort((a, b) =>
          a.packageName === b.packageName ? a.version.localeCompare(b.version) : a.packageName.localeCompare(b.packageName),
        );
        next.updatedAt = new Date().toISOString();
        next.schemaVersion = 1;
        return next;
      },
    );
  }

  async function removeIndexEntry(packageName: string, version: string): Promise<void> {
    await atomicMutateJson<GlobalLibraryIndex>(
      indexPath,
      () => ({ schemaVersion: 1 as const, updatedAt: new Date().toISOString(), installs: [] }),
      (current) => {
        const next = { ...current };
        next.installs = current.installs.filter(
          (e) => !(e.packageName === packageName && e.version === version),
        );
        next.updatedAt = new Date().toISOString();
        next.schemaVersion = 1;
        return next;
      },
    );
  }

  return { root, stage, readIndex, upsertIndexEntry, removeIndexEntry, pathFor, isInstalled };
}
