import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execa, type ExecaChildProcess, type ExecaReturnValue } from 'execa';
import type {
  CastManifest,
  CastPolicy,
  CloneAssignment,
  CloneRecord,
  CreateCastInput,
  Mode,
  RegisterInput,
} from '@manta/bus';
import { serializeSnapshot, type Snapshot } from '@manta/snapshot';
import { CliError } from '../errors.js';
import { buildInitialPrompt, buildPrimingText } from './priming.js';
import { installHeartbeatHook } from './heartbeat-hook.js';
import { installGitLockHook } from './git-lock-hook-installer.js';
import { installScopeGuardHook } from './scope-guard-hook-installer.js';
import { writeCloneMcpConfig } from './clone-mcp-config.js';

export interface CloneRunner {
  run(input: CloneRunnerInput): ExecaChildProcess;
}

export interface CloneRunnerInput {
  cwd: string;
  env: Record<string, string>;
  /** Priming text passed to `claude --append-system-prompt`. */
  appendSystemPrompt: string;
  /** Initial user prompt — the one-shot task description (Sec 9 point 1). */
  prompt: string;
  /** Session ID for daemon mode (enables --resume across invocations). */
  sessionId?: string;
  /**
   * bug #M14: path to the clone's minimal MCP config (just manta-bus). When set,
   * the runner spawns `claude` with `--strict-mcp-config --mcp-config <path>` so
   * the clone does NOT inherit the operator's heavy user-scope MCP stack (serena
   * cold-indexing the worktree, etc.) that wedges clone boot. Undefined → today's
   * inherit-everything behaviour (fallback when the config couldn't be written).
   */
  mcpConfigPath?: string;
}

/**
 * Narrow seam exposed by the production Bus Registry. Spawner uses only what
 * it needs (just `register`); unit tests can fake this without spinning up a
 * full `BusContext`. The full `Registry` from `@manta/bus` satisfies it.
 */
export interface RegistryWriter {
  register(input: RegisterInput): Promise<CloneRecord>;
  /**
   * bug #66: refresh a clone's last_heartbeat_at without changing state. The
   * spawner calls this as a "booting" heartbeat at process launch so the
   * STARTING grace is measured from launch, not pre-registration.
   */
  touch(cloneId: string): Promise<void>;
  /**
   * bug #70: read a clone's current state, used by the booting-ticker to know
   * when to stop touching. Returns null if the record is gone (deregistered).
   * `Registry.get` throws BusNotFoundError; this seam swallows that to null so
   * the ticker can treat "gone" the same as "settled" and exit cleanly.
   */
  getState(cloneId: string): Promise<string | null>;
}

/**
 * Narrow seam for the cast manifest writer. Mirrors `RegistryWriter` so unit
 * tests can fake `casts.create` without standing up a full `BusContext`. The
 * production `CastsStore` from `@manta/bus` satisfies this interface.
 */
export interface CastsCreator {
  create(input: CreateCastInput): Promise<CastManifest>;
}

export interface SpawnCloneOptions {
  repoRoot: string;
  snapshot: Snapshot;
  worktree: string;
  runner: CloneRunner;
  registry: RegistryWriter;
  casts: CastsCreator;
  /** Cast-level info needed to write/extend the manifest. */
  castMode: Mode;
  castPolicy: CastPolicy;
  /**
   * Full intended roster of clone_ids for this cast (in spawn order). The
   * spawner uses this to write the manifest on first clone of the cast; on
   * subsequent clones the manifest already exists and `casts.create` is
   * idempotent (same input).
   */
  castRoster: ReadonlyArray<{ clone_id: string; assignment: CloneAssignment | null }>;
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
  /** Session ID for daemon resume. Only set when session_mode === 'daemon'. */
  sessionId?: string;
  /** Whether this handle is a daemon (supports resume). */
  isDaemon: boolean;
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

  // Pre-register the clone on the Bus Registry BEFORE launching the runner.
  // Reason: closes manta-bugs #2 — the manta-as-clone skill text and user
  // docs claim the spawner registered the clone before launch. Without this
  // call, the orchestrator's first heartbeat-deadline could fire before the
  // clone process boots; the clone would then try to self-register and
  // either succeed (skill says it must NOT) or get not_found and abort.
  // Awaiting register before runner.run guarantees the record exists for
  // the first MCP call. If pre-register fails, snapshot file is orphaned in
  // .manta/snapshots/<castId>/; cast.ts teardown removes the worktree dir
  // (snapshots dir is reset between casts via `manta recover`).
  try {
    await opts.registry.register({
      clone_id: cloneId,
      mode: opts.snapshot.taskContract.mode,
      parent_pid: process.pid,
      worktree: opts.worktree,
      // metadata.cast_mode is the join key the Phase 2b sibling-messaging
      // filter uses without round-tripping the cast manifest for every check.
      // metadata.role (bug #M11) records the pair/test-storm slot (writer /
      // reviewer / coder / …) carried on the contract's approachHint, so the
      // death-detector can tell a reviewer that's legitimately blocked waiting
      // on its writer from one that's genuinely stuck. Empty string when no role.
      metadata: {
        cast_id: castId,
        cast_mode: opts.castMode,
        role: opts.snapshot.taskContract.approachHint ?? '',
      },
    });
  } catch (cause) {
    throw new CliError(`failed to pre-register clone ${cloneId}`, {
      kind: 'register_failed',
      cause,
    });
  }

  // Cast manifest is per-cast, not per-clone. We call `casts.create` for every
  // clone in the cast — `CastsStore.create` is idempotent on identical input,
  // so the first call writes the manifest and subsequent calls are no-ops.
  // This avoids a "first-clone-special" branch and survives clone-A failing
  // to spawn (clone-B's call still creates the manifest).
  try {
    await opts.casts.create({
      cast_id: castId,
      mode: opts.castMode,
      clones: [...opts.castRoster],
      policy: opts.castPolicy,
    });
  } catch (cause) {
    throw new CliError(`failed to create cast manifest for ${castId}`, {
      kind: 'register_failed',
      cause,
    });
  }

  await installHeartbeatHook(opts.worktree, opts.repoRoot, cloneId);

  // SECURITY — clone hard-guardrails (audit-v1 H "clone has no hard
  // guardrails"). Clones run `--permission-mode bypassPermissions`, so without
  // this the allowedPaths/forbiddenPaths scope fence is enforced ONLY as soft
  // priming text the model may ignore under task pressure — a clone could
  // `git push`, `rm -rf` outside its worktree, or touch the parent repo's
  // `.git`. Install an always-on PreToolUse scope/safety guard for EVERY clone
  // (not just test-storm). The hook runs in the harness, not the model, making
  // the scope fence and the dangerous-Bash blocklist a HARD invariant
  // (claude-code-pitfalls.md §4). It is appended after the heartbeat hook, so
  // both — plus the test-storm git-lock hook below — coexist on PreToolUse.
  await installScopeGuardHook(opts.worktree, {
    cloneId,
    allowedPaths: opts.snapshot.taskContract.scope.allowedPaths,
    forbiddenPaths: opts.snapshot.taskContract.scope.forbiddenPaths,
  });

  if (opts.castMode === 'test-storm') {
    const locksPath = path.join(opts.repoRoot, '.manta', 'state', 'locks.json');
    await installGitLockHook(opts.worktree, locksPath, cloneId);
  }

  // bug #M14: write a minimal MCP config (just manta-bus) into the worktree and
  // spawn the clone with `--strict-mcp-config` so it does NOT inherit the
  // operator's heavy user-scope stack (serena's per-worktree full-repo cold
  // index in particular wedges clone boot → reaped "no first heartbeat"). A
  // clone only needs the bus. Best-effort: if the write fails, fall back to NO
  // config (today's inherit-everything) — a slow clone beats a failed spawn.
  let mcpConfigPath: string | undefined;
  try {
    mcpConfigPath = await writeCloneMcpConfig({ worktreePath: opts.worktree });
  } catch {
    mcpConfigPath = undefined;
  }

  const proc = opts.runner.run({
    cwd: opts.worktree,
    env: {
      MANTA_SNAPSHOT_PATH: snapshotPath,
      MANTA_REPO_ROOT: opts.repoRoot,
      MANTA_CLONE_ID: cloneId,
      MANTA_BUS_PEER_SCOPE:
        opts.snapshot.taskContract.mode === 'forking-realities'
          ? 'parent-only'
          : 'siblings-allowed',
    },
    appendSystemPrompt: buildPrimingText(opts.snapshot),
    prompt: buildInitialPrompt(opts.snapshot),
    ...(mcpConfigPath !== undefined ? { mcpConfigPath } : {}),
  });

  // bug #66: the clone is pre-registered STARTING (with registered_at = now)
  // BEFORE this point; cold-start (`claude --print` boot + `--resume` transcript
  // replay + MCP handshake) can exceed the startup grace when it's measured from
  // registration — the clone is reaped before it can possibly make its first bus
  // call, and the failure scales with parent-transcript size. Emit a "booting"
  // heartbeat the instant the child process is launched so the death-detector's
  // STARTING grace is measured from LAUNCH (after all pre-launch prep), not from
  // pre-registration. Best-effort: if it fails, the clone's own first MCP call
  // still refreshes the heartbeat — we only lose the launch-time grace reset.
  try {
    await opts.registry.touch(cloneId);
  } catch {
    // non-fatal — see comment above.
  }

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

  // bug #70: the launch heartbeat above fires ONCE. After it, last_heartbeat_at
  // is only refreshed by the per-tool-call hook — but during cold boot the child
  // makes NO tool calls for minutes (it's replaying a large --resume transcript +
  // MCP handshake before its first action). So the heartbeat freezes at launch
  // time and the death-detector reaps the clone at startupGraceMs even though the
  // process is alive and booting. This was reproduced live: a clone forked from an
  // 18 MB session was reaped at "startup grace 601876ms > 600000ms (no first
  // heartbeat)". Fix: keep touching last_heartbeat_at on an interval WHILE the
  // clone is still STARTING, so the grace window tracks a live-but-quiet boot. The
  // ticker self-stops the moment the clone leaves STARTING (its own heartbeat took
  // over) or the record is gone — so it never masks a genuinely hung WORKING clone
  // (that path is still governed by heartbeatTimeoutMs), and the death-detector's
  // absolute STARTING cap (measured from registered_at) still reaps a process that
  // hangs in STARTING forever. Best-effort throughout: a missed tick is harmless.
  const BOOT_TICK_MS = 30_000;
  let bootTicking = false;
  const bootTicker: ReturnType<typeof setInterval> = setInterval(() => {
    if (bootTicking) return; // don't overlap a slow tick
    bootTicking = true;
    void (async () => {
      try {
        const state = await opts.registry.getState(cloneId);
        if (state !== 'STARTING') {
          clearInterval(bootTicker);
          return;
        }
        await opts.registry.touch(cloneId);
      } catch {
        // best-effort — a missed cold-boot heartbeat is recoverable.
      } finally {
        bootTicking = false;
      }
    })();
  }, BOOT_TICK_MS);
  // Never let the ticker keep the event loop alive on its own.
  if (typeof bootTicker.unref === 'function') bootTicker.unref();
  // Stop ticking the instant the process exits, whatever the reason.
  void exit.then(
    () => clearInterval(bootTicker),
    () => clearInterval(bootTicker),
  );

  // I-5 (Chunk-1 review): graceful kill with SIGKILL escalation. The kill
  // command and abort command call this so a hung clone (e.g. `MANTA_FAKE_
  // CLONE_STATE=hang` or a real wedged claude --print) cannot block the
  // operator's CTRL-C. SIGTERM goes first, then 5s later SIGKILL.
  const terminate = async (
    terminateOpts?: { gracefulMs?: number },
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null }> => {
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
    ...((opts.snapshot as { sessionId?: string }).sessionId != null
      ? { sessionId: (opts.snapshot as { sessionId?: string }).sessionId }
      : {}),
    isDaemon: (opts.snapshot as { sessionMode?: string }).sessionMode === 'daemon',
  };
}

export interface RunFakeCloneScriptOptions {
  scriptPath: string;
  env?: Record<string, string>;
}

export function runFakeCloneScript(opts: RunFakeCloneScriptOptions): CloneRunner {
  return {
    run(input) {
      // Fake runner ignores `appendSystemPrompt` and `prompt` — those are for
      // the real `claude` binary's flags. Test fixtures read MANTA_SNAPSHOT_PATH
      // from env directly.
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
      const sessionArgs: string[] = input.sessionId
        ? ['--session-id', input.sessionId]
        : [];
      // bug #M14: spawn with ONLY the clone's minimal MCP config (manta-bus),
      // ignoring the operator's heavy user-scope stack that wedges clone boot.
      const mcpArgs: string[] = input.mcpConfigPath
        ? ['--strict-mcp-config', '--mcp-config', input.mcpConfigPath]
        : [];
      return execa(
        bin,
        [
          '--print',
          ...sessionArgs,
          ...mcpArgs,
          ...(opts.extraArgs ?? []),
          '--append-system-prompt',
          input.appendSystemPrompt,
          '--permission-mode',
          'bypassPermissions',
          input.prompt,
        ],
        { cwd: input.cwd, env: { ...process.env, ...input.env }, reject: false },
      );
    },
  };
}

export interface ResumeOptions {
  claudeBin?: string;
  sessionId: string;
  extraArgs?: string[];
}

export interface SelectCloneRunnerArgs {
  /** Snapshot's effective resume flag (post size-guard, per clone). */
  resumeEnabled: boolean;
  /** The clone's private forked session id (Chunk 2), or undefined. */
  forkedSessionId: string | undefined;
  /**
   * Runner used when NOT resuming — today's no-session path. In production
   * this is `runClaudeCli()`; tests pass a fake capturing runner (DI seam).
   */
  fallback: CloneRunner;
  /**
   * Forwarded to `runClaudeResume` when resuming. Tests inject `/usr/bin/echo`
   * to capture argv via `spawnargs`; production omits it (defaults to `claude`,
   * matching the `fallback` runner's default bin).
   */
  claudeBin?: string;
}

/**
 * RB1/bug #56 (Chunk 3, Decision #2): choose the clone runner from snapshot
 * data — NOT an `if NODE_ENV` branch. When the clone has a forked transcript
 * to continue (`resumeEnabled && forkedSessionId`), return `runClaudeResume`
 * so it boots as a continuation of the parent conversation; otherwise return
 * the `fallback` runner unchanged (today's `runClaudeCli` behaviour, byte-
 * identical — proven by the resume suite's no-regression assertion).
 */
export function selectCloneRunner(args: SelectCloneRunnerArgs): CloneRunner {
  if (args.resumeEnabled && args.forkedSessionId) {
    return runClaudeResume({
      sessionId: args.forkedSessionId,
      ...(args.claudeBin !== undefined ? { claudeBin: args.claudeBin } : {}),
    });
  }
  return args.fallback;
}

export function runClaudeResume(opts: ResumeOptions): CloneRunner {
  const bin = opts.claudeBin ?? 'claude';
  return {
    run(input) {
      // bug #M14: same minimal-MCP isolation on the resume path.
      const mcpArgs: string[] = input.mcpConfigPath
        ? ['--strict-mcp-config', '--mcp-config', input.mcpConfigPath]
        : [];
      return execa(
        bin,
        [
          '--print',
          '--resume', opts.sessionId,
          ...mcpArgs,
          ...(opts.extraArgs ?? []),
          '--append-system-prompt',
          input.appendSystemPrompt,
          '--permission-mode',
          'bypassPermissions',
          input.prompt,
        ],
        { cwd: input.cwd, env: { ...process.env, ...input.env }, reject: false },
      );
    },
  };
}
