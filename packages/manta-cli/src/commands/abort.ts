import type { Runtime } from '../runtime.js';
import type { Reporter } from '../output/reporter.js';
import type { CommandResult } from './status.js';
import { fsPostMortemWriter, runPostMortem } from '@manta/orchestrator';

/**
 * Injectable OS-signal seam (default: real `process.kill`). Tests stub this to
 * assert abort signals every live clone's process group without sending real
 * signals. Kept narrow (pid + signal) so the stub is trivial.
 */
export type KillFn = (pid: number, signal: NodeJS.Signals) => void;

export interface RunAbortOptions {
  reason: string;
  reporter: Reporter;
  /** Override the OS kill seam (tests). Defaults to `process.kill`. */
  kill?: KillFn;
  /** Grace, in ms, between SIGTERM and the SIGKILL escalation. Default 5000. */
  gracefulMs?: number;
  /** Sleep seam (tests pass a no-op to skip the real grace wait). */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_GRACEFUL_MS = 5_000;

const realKill: KillFn = (pid, signal) => {
  process.kill(pid, signal);
};

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Best-effort signal to a clone's recorded process AND its process group.
 *
 * `parent_pid` is the `manta cast` spawner's pid; the `claude --print` clones
 * are its children in the same process group, so signalling the group (the
 * negative pid) reaps the whole runaway tree. Bug #65 class: before this,
 * `manta abort` only markDead'd the registry record and left the OS processes
 * alive — orphan clones that kept burning tokens after the operator aborted.
 *
 * Falls back to the bare pid when the group signal fails (the spawner may not
 * be a group leader). Every failure is swallowed: a process that already exited
 * (ESRCH) or a since-reused pid must never abort the abort. We also refuse to
 * signal pid <= 1 (init / whole system) or our own abort process (self-kill).
 */
function signalCloneTree(pid: number, signal: NodeJS.Signals, kill: KillFn): void {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return;
  try {
    kill(-pid, signal); // negative pid = the process group
  } catch {
    try {
      kill(pid, signal); // fall back to the single recorded process
    } catch {
      // already gone / reused — nothing left to signal
    }
  }
}

/**
 * `manta abort` — terminate every live clone's OS process, then mark each DEAD
 * and write a post-mortem.
 *
 * Order matters (bug #65): the OS processes are SIGTERM'd (then SIGKILL'd after
 * a grace) BEFORE any markDead, so abort never records a clone as DEAD while its
 * process keeps running. Already-DEAD clones are left alone (their original
 * death_reason is preserved). The abort event is appended after each clone's
 * post-mortem so a partial failure still leaves a clean audit trail.
 */
export async function runAbortCommand(
  rt: Runtime,
  opts: RunAbortOptions,
): Promise<CommandResult> {
  const all = await rt.ctx.registry.list();
  const live = all.filter((c) => c.state !== 'DEAD');

  const kill = opts.kill ?? realKill;
  const sleep = opts.sleep ?? realSleep;
  const gracefulMs = opts.gracefulMs ?? DEFAULT_GRACEFUL_MS;

  // ── Phase 1: stop the OS processes BEFORE markDead ──────────────────────
  // SIGTERM every live clone's process group first (clean shutdown chance),
  // wait the grace once, then SIGKILL any survivor. Done before markDead so the
  // registry can never claim a clone is DEAD while its process is still running.
  const livePids = live
    .map((c) => c.parent_pid)
    .filter((pid): pid is number => typeof pid === 'number');

  for (const pid of livePids) signalCloneTree(pid, 'SIGTERM', kill);
  if (livePids.length > 0) {
    await sleep(gracefulMs);
    for (const pid of livePids) signalCloneTree(pid, 'SIGKILL', kill);
  }

  // ── Phase 2: markDead + audit trail ─────────────────────────────────────
  const writer = fsPostMortemWriter({
    repoRoot: rt.repoRoot,
    postMortemDir: rt.thresholds.postMortemDir,
  });
  for (const c of live) {
    await runPostMortem(rt.ctx, {
      cloneId: c.clone_id,
      reason: `abort: ${opts.reason}`,
      writer,
      thresholds: rt.thresholds,
    });
    await rt.ctx.events.append({
      type: 'abort',
      clone_id: c.clone_id,
      payload: { reason: opts.reason },
    });
  }
  opts.reporter.info('abort', { aborted: live.length, reason: opts.reason });
  return {
    exitCode: 0,
    stdout: `Aborted ${live.length} clone(s).`,
  };
}
