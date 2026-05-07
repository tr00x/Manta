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
}

const SAFE_KEY = /^[A-Za-z0-9._-]+$/;

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
  return {
    cloneId,
    pid: proc.pid,
    snapshotPath,
    exit: proc.then(
      (r: ExecaReturnValue) => ({
        code: r.exitCode ?? null,
        signal: (r as { signal?: NodeJS.Signals }).signal ?? null,
      }),
      (err: { exitCode?: number; signal?: NodeJS.Signals }) => ({
        code: err.exitCode ?? null,
        signal: err.signal ?? null,
      }),
    ),
    kill: (signal) => {
      proc.kill(signal);
    },
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
