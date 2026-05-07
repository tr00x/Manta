import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { BusStateError } from './errors';

const LOCK_OPTS = {
  retries: { retries: 50, minTimeout: 5, maxTimeout: 50, factor: 1.2 },
  stale: 30_000,
  realpath: false,
};

async function ensureDir(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function ensureExists(filePath: string, init: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    await ensureDir(filePath);
    // 'wx' = exclusive create; ignore EEXIST race losers — they read the winner's file.
    try {
      const handle = await fs.open(filePath, 'wx');
      try {
        await handle.writeFile(init);
      } finally {
        await handle.close();
      }
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
}

export async function atomicReadJson<T>(filePath: string, defaultFactory: () => T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (err: any) {
    if (err && err.code === 'ENOENT') {
      return defaultFactory();
    }
    throw new BusStateError(`atomicReadJson: failed to read ${filePath}`, { cause: err });
  }
}

export async function atomicMutateJson<T>(
  filePath: string,
  defaultFactory: () => T,
  mutator: (current: T) => T | Promise<T>,
): Promise<T> {
  await ensureDir(filePath);
  await ensureExists(filePath, JSON.stringify(defaultFactory(), null, 2));
  const release = await lockfile.lock(filePath, LOCK_OPTS);
  try {
    const current = await atomicReadJson<T>(filePath, defaultFactory);
    const next = await mutator(current);
    const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
    await fs.rename(tmp, filePath);
    return next;
  } finally {
    await release();
  }
}

export async function appendJsonLine(filePath: string, record: unknown): Promise<void> {
  await ensureDir(filePath);
  const line = `${JSON.stringify(record)}\n`;
  // Per-file proper-lockfile guard so writers from concurrent processes serialize.
  await ensureExists(filePath, '');
  const release = await lockfile.lock(filePath, LOCK_OPTS);
  try {
    await fs.appendFile(filePath, line, 'utf8');
  } finally {
    await release();
  }
}
