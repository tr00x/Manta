import type { Runtime } from '../runtime.js';
import type { Reporter } from '../output/reporter.js';
import type { CommandResult } from './status.js';
import { CliError } from '../errors.js';
import { fsPostMortemWriter, runPostMortem } from '@manta/orchestrator';
import { reapPids, type KillFn } from '../spawner/reap-pids.js';

export interface RunKillOptions {
  cloneId: string;
  reason: string;
  reporter: Reporter;
  /** Override the OS kill seam (tests). Defaults to `process.kill`. */
  kill?: KillFn;
  /** Sleep seam (tests pass a no-op to skip the real grace wait). */
  sleep?: (ms: number) => Promise<void>;
  /** Grace, in ms, between SIGTERM and SIGKILL. Default 5000. */
  gracefulMs?: number;
  /** PID-liveness re-probe before SIGKILL (tests pass `() => true`). */
  isAlive?: (pid: number) => boolean;
}

/**
 * `manta kill <cloneId>` — mark one clone DEAD and write its post-mortem.
 *
 * If the clone is already DEAD, `runPostMortem` is idempotent (preserves the
 * original `death_reason`) — this matches the orchestrator's reaper behavior
 * so a kill-then-recover sequence does not double-stamp.
 */
export async function runKillCommand(
  rt: Runtime,
  opts: RunKillOptions,
): Promise<CommandResult> {
  let record;
  try {
    record = await rt.ctx.registry.get(opts.cloneId);
  } catch (err) {
    throw new CliError(`clone not found: ${opts.cloneId}`, {
      kind: 'not_found',
      cause: err,
    });
  }

  // #65: stop the clone's OS process BEFORE markDead, so kill never records a
  // clone as DEAD while its `claude --print` keeps running (orphan burning
  // subscription rate). Signal ONLY this clone's own pid (group:false) — never
  // the parent group — so a sibling clone or a still-running cast process is
  // never collaterally killed. No-op when the pid was never recorded (legacy
  // record / killed before launch) or the clone is already DEAD.
  if (record.state !== 'DEAD' && typeof record.clone_pid === 'number') {
    await reapPids([{ pid: record.clone_pid, group: false }], {
      ...(opts.kill !== undefined ? { kill: opts.kill } : {}),
      ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
      ...(opts.gracefulMs !== undefined ? { gracefulMs: opts.gracefulMs } : {}),
      ...(opts.isAlive !== undefined ? { isAlive: opts.isAlive } : {}),
    });
  }

  // runPostMortem will mark DEAD itself if the clone isn't already; this
  // single call covers state transition + artifact write + post_mortem event.
  // Doing markDead manually beforehand would race the post-mortem's idempotency
  // check (which preserves the original death_reason).
  const writer = fsPostMortemWriter({
    repoRoot: rt.repoRoot,
    postMortemDir: rt.thresholds.postMortemDir,
  });
  await runPostMortem(rt.ctx, {
    cloneId: opts.cloneId,
    reason: `kill: ${opts.reason}`,
    writer,
    thresholds: rt.thresholds,
  });
  await rt.ctx.events.append({
    type: 'kill',
    clone_id: opts.cloneId,
    payload: { reason: opts.reason },
  });
  opts.reporter.info('kill', { cloneId: opts.cloneId, reason: opts.reason });
  return {
    exitCode: 0,
    stdout: `Killed clone ${opts.cloneId} (was ${record.state}).`,
  };
}
