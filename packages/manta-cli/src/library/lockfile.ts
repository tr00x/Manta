import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { z } from 'zod';
import { atomicMutateJson, atomicReadJson } from '@manta/bus';

const SHA256_BASE64 = /^sha256-[A-Za-z0-9+/=]+$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SEMVER_RANGE = /^(?:[\^~><=]{0,2}\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?(?:\s*-\s*\d+(?:\.\d+){0,2})?(?:\s+(?:[\^~><=]{0,2}\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?))*|\*)$/;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export const ManifestLockEntrySchema = z
  .object({
    version: z.string().regex(SEMVER, 'version must be semver MAJOR.MINOR.PATCH'),
    resolved: z.string().min(1),
    integrity: z.string().regex(SHA256_BASE64, 'integrity must be sha256-<base64>'),
    directoryDigest: z
      .string()
      .regex(SHA256_BASE64, 'directoryDigest must be sha256-<base64>'),
    contributes: z
      .object({
        modes: z.array(z.string()),
        skills: z.array(z.string()),
        commands: z.array(z.string()),
        templates: z.array(z.string()),
      })
      .strict(),
    mantaVersionCompat: z
      .string()
      .min(1)
      .refine((v) => SEMVER_RANGE.test(v.trim()), {
        message: 'mantaVersionCompat must be a valid semver range',
      }),
    installedAt: z.string().regex(ISO_8601, 'installedAt must be ISO-8601'),
  })
  .strict();

export type LockfileEntry = z.infer<typeof ManifestLockEntrySchema>;

export const LockfileSchema = z
  .object({
    schemaVersion: z.literal(1),
    mantaVersion: z.string().regex(SEMVER, 'mantaVersion must be semver'),
    generatedAt: z.string().regex(ISO_8601, 'generatedAt must be ISO-8601'),
    packages: z.record(ManifestLockEntrySchema),
  })
  .strict();

export type Lockfile = z.infer<typeof LockfileSchema>;

export interface LockfileStore {
  readonly path: string;
  read(): Promise<Lockfile | null>;
  write(lock: Lockfile): Promise<void>;
  mutate(fn: (current: Lockfile | null) => Promise<Lockfile> | Lockfile): Promise<Lockfile>;
}

export interface CreateLockfileStoreOptions {
  repoRoot: string;
}

export const LOCKFILE_NAME = 'manta-lock.json';

const SENTINEL = Symbol('lockfile-missing');

function canonicalize(lock: Lockfile): Lockfile {
  const sortedPackageNames = Object.keys(lock.packages).sort();
  const packages: Record<string, LockfileEntry> = {};
  for (const name of sortedPackageNames) {
    const entry = lock.packages[name];
    packages[name] = {
      version: entry.version,
      resolved: entry.resolved,
      integrity: entry.integrity,
      directoryDigest: entry.directoryDigest,
      contributes: {
        modes: [...entry.contributes.modes].sort(),
        skills: [...entry.contributes.skills].sort(),
        commands: [...entry.contributes.commands].sort(),
        templates: [...entry.contributes.templates].sort(),
      },
      mantaVersionCompat: entry.mantaVersionCompat,
      installedAt: entry.installedAt,
    };
  }
  return {
    schemaVersion: lock.schemaVersion,
    mantaVersion: lock.mantaVersion,
    generatedAt: lock.generatedAt,
    packages,
  };
}

function serialize(lock: Lockfile): string {
  return `${JSON.stringify(canonicalize(lock), null, 2)}\n`;
}

export function createLockfileStore(opts: CreateLockfileStoreOptions): LockfileStore {
  const filePath = path.resolve(opts.repoRoot, LOCKFILE_NAME);

  async function read(): Promise<Lockfile | null> {
    const parsed = await atomicReadJson<typeof SENTINEL | unknown>(filePath, () => SENTINEL);
    if (parsed === SENTINEL) return null;
    const r = LockfileSchema.safeParse(parsed);
    if (!r.success) {
      throw new Error(`manta-lock.json failed schema validation: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    return r.data;
  }

  async function write(lock: Lockfile): Promise<void> {
    const parsed = LockfileSchema.parse(lock);
    const canonical = canonicalize(parsed);
    const body = `${JSON.stringify(canonical, null, 2)}\n`;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(tmp, body, 'utf8');
    await fs.rename(tmp, filePath);
  }

  async function mutate(fn: (current: Lockfile | null) => Promise<Lockfile> | Lockfile): Promise<Lockfile> {
    const result = await atomicMutateJson<unknown>(
      filePath,
      () => SENTINEL as unknown,
      async (current) => {
        const parsedCurrent: Lockfile | null = current === SENTINEL ? null : LockfileSchema.parse(current);
        const next = await fn(parsedCurrent);
        const validated = LockfileSchema.parse(next);
        return canonicalize(validated) as unknown;
      },
    );
    const final = LockfileSchema.parse(result);
    // Re-write with our canonical serializer (trailing newline + sorted keys)
    // — atomicMutateJson uses JSON.stringify without trailing newline.
    const body = serialize(final);
    const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(tmp, body, 'utf8');
    await fs.rename(tmp, filePath);
    return final;
  }

  return { path: filePath, read, write, mutate };
}
