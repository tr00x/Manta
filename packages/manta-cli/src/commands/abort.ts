import type { Runtime } from '../runtime.js';
import type { Reporter } from '../output/reporter.js';
import type { CommandResult } from './status.js';
import { fsPostMortemWriter, runPostMortem } from '@manta/orchestrator';
import { reapPids, type KillFn, type ReapTarget } from '../spawner/reap-pids.js';

/** Re-exported for command callers/tests that stub the OS-signal seam. */
export type { KillFn };

export interface RunAbortOptions {
  reason: string;
  reporter: Reporter;
  /** Override the OS kill seam (tests). Defaults to `process.kill`. */
  kill?: KillFn;
  /** Grace, in ms, between SIGTERM and the SIGKILL escalation. Default 5000. */
  gracefulMs?: number;
  /** Sleep seam (tests pass a no-op to skip the real grace wait). */
  sleep?: (ms: number) => Promise<void>;
  /** PID-liveness re-probe before SIGKILL (tests pass `() => true`). */
  isAlive?: (pid: number) => boolean;
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

  // ── Phase 1: stop the OS processes BEFORE markDead ──────────────────────
  // SIGTERM every live clone, wait the grace once, then SIGKILL survivors —
  // done before markDead so the registry can never claim a clone is DEAD while
  // its process is still running. Two targets per clone:
  //   • parent_pid as a GROUP signal — reaps the whole still-live cast tree
  //     (the `claude --print` children + their MCP-server grandchildren).
  //   • clone_pid as a bare-process signal (#65) — reaches a clone whose parent
  //     cast process has already exited (reparented to init), which the group
  //     signal can no longer hit.
  const targets: ReapTarget[] = [];
  for (const c of live) {
    if (typeof c.parent_pid === 'number') targets.push({ pid: c.parent_pid, group: true });
    if (typeof c.clone_pid === 'number') targets.push({ pid: c.clone_pid, group: false });
  }
  await reapPids(targets, {
    ...(opts.kill !== undefined ? { kill: opts.kill } : {}),
    ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
    ...(opts.gracefulMs !== undefined ? { gracefulMs: opts.gracefulMs } : {}),
    ...(opts.isAlive !== undefined ? { isAlive: opts.isAlive } : {}),
  });

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
