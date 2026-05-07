import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execa, type ExecaChildProcess, type ExecaReturnValue } from 'execa';
import { serializeSnapshot, type Snapshot } from '@manta/snapshot';
import { CliError } from '../errors.js';

export interface CloneRunner {
  run(input: CloneRunnerInput): ExecaChildProcess;
}

export interface CloneRunnerInput {
  cwd: string;
  env: Record<string, string>;
  snapshotPath: string;
}

export interface SpawnCloneOptions {
  repoRoot: string;
  snapshot: Snapshot;
  worktree: string;
  runner: CloneRunner;
}

export interface CloneHandle {
  cloneId: string;
  pid: number | undefined;
  snapshotPath: string;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill: (signal: NodeJS.Signals) => void;
  /**
   * Graceful termination: SIGTERM, then SIGKILL after `gracefulMs` if the
   * child is still alive. Returns the eventual exit record. Default
   * `gracefulMs` is 5_000.
   */
  terminate: (opts?: { gracefulMs?: number }) => Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const SAFE_KEY = /^[A-Za-z0-9._-]+$/;
const DEFAULT_GRACEFUL_MS = 5_000;

export async function spawnClone(opts: SpawnCloneOptions): Promise<CloneHandle> {
  const cloneId = opts.snapshot.taskContract.cloneId;
  const castId = opts.snapshot.castId;
  if (!SAFE_KEY.test(castId)) {
    throw new CliError(`unsafe castId in snapshot: ${castId}`, { kind: 'invalid_input' });
  }
  if (!SAFE_KEY.test(cloneId)) {
    throw new CliError(`unsafe clone_id: ${cloneId}`, { kind: 'invalid_input' });
  }
  const dir = path.join(opts.repoRoot, '.manta', 'snapshots', castId);
  await fs.mkdir(dir, { recursive: true });
  const snapshotPath = path.join(dir, `${cloneId}.snapshot.json`);
  await serializeSnapshot(opts.snapshot, snapshotPath);

  const proc = opts.runner.run({
    cwd: opts.worktree,
    env: {
      MANTA_SNAPSHOT_PATH: snapshotPath,
      MANTA_REPO_ROOT: opts.repoRoot,
      MANTA_CLONE_ID: cloneId,
    },
    snapshotPath,
  });

  // I-1 (Chunk-1 review): with `reject: false`, `claude --print` (or any
  // runner) that fails to *start* (ENOENT, missing binary, permission)
  // resolves the promise with `failed: true` and `exitCode == null`. The
  // previous handler silently masked this as `{ code: null, signal: null }`,
  // which the cast loop then interprets as "process exited cleanly". We
  // surface it as a `spawn_failed` CliError instead, so the cast aborts at
  // the spawn step rather than waiting for a heartbeat that never lands.
  const exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> = (async () => {
    type ExitLike = {
      exitCode?: number | null;
      signal?: NodeJS.Signals | null;
      failed?: boolean;
    };
    let r: ExitLike;
    try {
      r = (await proc) as ExecaReturnValue & ExitLike;
    } catch (err) {
      r = err as ExitLike;
    }
    if (r.failed && r.exitCode == null && r.signal == null) {
      throw new CliError('clone runner failed to start', {
        kind: 'spawn_failed',
        cause: r,
      });
    }
    return {
      code: r.exitCode ?? null,
      signal: r.signal ?? null,
    };
  })();

  // I-5 (Chunk-1 review): graceful kill with SIGKILL escalation. The kill
  // command and abort command call this so a hung clone (e.g. `MANTA_FAKE_
  // CLONE_STATE=hang` or a real wedged claude --print) cannot block the
  // operator's CTRL-C. SIGTERM goes first, then 5s later SIGKILL.
  const terminate = async (terminateOpts?: { gracefulMs?: number }) => {
    const gracefulMs = terminateOpts?.gracefulMs ?? DEFAULT_GRACEFUL_MS;
    try {
      proc.kill('SIGTERM');
    } catch {
      // already exited — exit promise will resolve normally
    }
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const escalation = new Promise<void>((resolve) => {
      killTimer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // already exited
        }
        resolve();
      }, gracefulMs);
    });
    const settled: Promise<{ code: number | null; signal: NodeJS.Signals | null }> = exit.then(
      (r) => r,
      // If the exit promise threw (e.g. spawn_failed), best-effort report
      // null/null so callers don't need to handle a rejected exit here.
      () => ({ code: null, signal: null }),
    );
    const result = await Promise.race([settled, escalation.then(() => settled)]);
    if (killTimer) clearTimeout(killTimer);
    return result;
  };

  return {
    cloneId,
    pid: proc.pid,
    snapshotPath,
    exit,
    kill: (signal) => {
      proc.kill(signal);
    },
    terminate,
  };
}

export interface RunFakeCloneScriptOptions {
  scriptPath: string;
  env?: Record<string, string>;
}

export function runFakeCloneScript(opts: RunFakeCloneScriptOptions): CloneRunner {
  return {
    run(input) {
      return execa(process.execPath, [opts.scriptPath], {
        cwd: input.cwd,
        env: { ...process.env, ...input.env, ...opts.env },
        reject: false,
      });
    },
  };
}

export interface RunClaudeCliOptions {
  claudeBin?: string;
  extraArgs?: string[];
}

export function runClaudeCli(opts: RunClaudeCliOptions = {}): CloneRunner {
  const bin = opts.claudeBin ?? 'claude';
  return {
    run(input) {
      return execa(
        bin,
        ['--print', ...(opts.extraArgs ?? []), '--snapshot', input.snapshotPath],
        { cwd: input.cwd, env: { ...process.env, ...input.env }, reject: false },
      );
    },
  };
}
