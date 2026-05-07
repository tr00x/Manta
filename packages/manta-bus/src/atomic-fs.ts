import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { BusStateError } from './errors';

// Two-layer locking model recap (see also state/locks.ts):
//   - proper-lockfile `stale: 30_000` is the *file-mutex* stealing threshold,
//     used to recover from a process that died holding the lock. It is NOT
//     the business-level lease GC threshold — that's owned by LocksStore.
//   - `Date.now()` in tmp-file names below is purely for filename-collision
//     avoidance under the same pid + same ms; it is not deterministic-test
//     sensitive (FakeClock does not need to control it).
const LOCK_OPTS = {
  retries: { retries: 50, minTimeout: 5, maxTimeout: 50, factor: 1.2 },
  stale: 30_000,
  realpath: false,
};

async function ensureDir(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

function errCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

async function readJsonOrNull<T>(filePath: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (errCode(err) === 'ENOENT') return null;
    throw new BusStateError(`atomic-fs: failed to read ${filePath}`, { cause: err });
  }
  // Empty file = "uninitialized": atomicMutateJson creates a 0-byte placeholder
  // before locking (so proper-lockfile has a target), then the first mutator
  // under the lock writes real JSON via tmp + rename. Readers seeing the empty
  // placeholder treat it the same as ENOENT.
  if (raw === '') return null;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new BusStateError(`atomic-fs: failed to parse ${filePath}`, { cause: err });
  }
}

/**
 * Read a JSON file, returning `defaultFactory()` if the file does not exist.
 *
 * Lock-free read by design: callers that need read-modify-write atomicity must
 * use {@link atomicMutateJson}. Concurrent readers tolerate a writer's
 * tmp-file + rename atomicity — they will see either the pre- or post-write
 * state, never a torn JSON.
 */
export async function atomicReadJson<T>(filePath: string, defaultFactory: () => T): Promise<T> {
  const v = await readJsonOrNull<T>(filePath);
  return v === null ? defaultFactory() : v;
}

/**
 * Acquire the file mutex, then read-modify-write the JSON file atomically.
 *
 * Initialization (when the file is missing) happens **inside** the lock — so
 * two concurrent callers against a non-existent file cannot race: the first
 * acquirer reads ENOENT, applies the mutator on top of `defaultFactory()`,
 * and writes via tmp + rename; the second acquirer then reads the post-write
 * state. There is no `wx`-open before the lock.
 */
export async function atomicMutateJson<T>(
  filePath: string,
  defaultFactory: () => T,
  mutator: (current: T) => T | Promise<T>,
): Promise<T> {
  await ensureDir(filePath);
  // proper-lockfile creates the lockfile sibling itself; we must ensure the
  // *target* file's directory exists, but the file itself need not.
  // proper-lockfile.lock(path) requires the path to exist, so create an empty
  // placeholder under O_CREAT (idempotent) before locking. The placeholder
  // body is irrelevant — the first mutator under the lock overwrites it via
  // tmp + rename.
  const handle = await fs.open(filePath, 'a');
  await handle.close();
  const release = await lockfile.lock(filePath, LOCK_OPTS);
  try {
    const existing = await readJsonOrNull<T>(filePath);
    const current = existing === null ? defaultFactory() : existing;
    const next = await mutator(current);
    const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
    await fs.rename(tmp, filePath);
    return next;
  } finally {
    await release();
  }
}

/**
 * Append one JSON record + newline to the file under the file mutex.
 *
 * Concurrent appenders from the same or different processes serialize through
 * proper-lockfile so there are no torn writes. Readers (e.g. EventsLog.readAll)
 * may see a partial last line if the writer crashed mid-append; readers must
 * tolerate that (per-line try/catch + skip).
 */
export async function appendJsonLine(filePath: string, record: unknown): Promise<void> {
  await ensureDir(filePath);
  // Same placeholder-create pattern as atomicMutateJson — proper-lockfile
  // requires the target to exist before locking.
  const handle = await fs.open(filePath, 'a');
  await handle.close();
  const release = await lockfile.lock(filePath, LOCK_OPTS);
  try {
    const line = `${JSON.stringify(record)}\n`;
    await fs.appendFile(filePath, line, 'utf8');
  } finally {
    await release();
  }
}
