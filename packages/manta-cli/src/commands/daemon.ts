import type { Runtime } from '../runtime.js';
import type { Reporter } from '../output/reporter.js';
import type { CommandResult } from './status.js';
import { reapPids, type KillFn, type ReapTarget } from '../spawner/reap-pids.js';

/** Re-exported for command callers/tests that stub the OS-signal seam. */
export type { KillFn };

export interface DaemonStatusOptions {
  reporter: Reporter;
}

export async function runDaemonStatusCommand(
  rt: Runtime,
  _opts: DaemonStatusOptions,
): Promise<CommandResult> {
  const allClones = await rt.ctx.registry.list();
  const daemonClones = allClones.filter(
    (c) => c.session_mode === 'daemon' && c.state !== 'DEAD',
  );
  if (daemonClones.length === 0) {
    return { exitCode: 0, stdout: 'No active daemon clones.' };
  }
  const lines = daemonClones.map((c) =>
    `${c.clone_id}\t${c.state}\ttasks=${c.tasks_completed ?? 0}\tidle_since=${c.idle_since ? new Date(c.idle_since).toISOString() : 'n/a'}`,
  );
  return { exitCode: 0, stdout: `Active daemon clones:\n${lines.join('\n')}` };
}

export interface DaemonStopOptions {
  reporter: Reporter;
  reason?: string | undefined;
  /** Override the OS kill seam (tests). Defaults to `process.kill`. */
  kill?: KillFn;
  /** Grace, in ms, between SIGTERM and the SIGKILL escalation. Default 5000. */
  gracefulMs?: number;
  /** Sleep seam (tests pass a no-op to skip the real grace wait). */
  sleep?: (ms: number) => Promise<void>;
  /** PID-liveness re-probe before SIGKILL (tests pass `() => true`). */
  isAlive?: (pid: number) => boolean;
}

export async function runDaemonStopCommand(
  rt: Runtime,
  opts: DaemonStopOptions,
): Promise<CommandResult> {
  const allClones = await rt.ctx.registry.list();
  const daemonClones = allClones.filter(
    (c) => c.session_mode === 'daemon' && c.state !== 'DEAD',
  );

  // Stop the OS processes BEFORE markDead (bug #65). markDead only relabels the
  // registry record — a daemon clone's `claude --print`/`--resume` keeps running
  // (and burning the subscription) until it is actually signalled. Mirror the
  // abort/kill reap: parent_pid as a GROUP reaps a still-live cast tree; clone_pid
  // bare reaches a clone whose parent cast has exited and was reparented to init.
  const targets: ReapTarget[] = [];
  for (const c of daemonClones) {
    if (typeof c.parent_pid === 'number') targets.push({ pid: c.parent_pid, group: true });
    if (typeof c.clone_pid === 'number') targets.push({ pid: c.clone_pid, group: false });
  }
  await reapPids(targets, {
    ...(opts.kill !== undefined ? { kill: opts.kill } : {}),
    ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
    ...(opts.gracefulMs !== undefined ? { gracefulMs: opts.gracefulMs } : {}),
    ...(opts.isAlive !== undefined ? { isAlive: opts.isAlive } : {}),
  });

  for (const c of daemonClones) {
    await rt.ctx.registry.markDead(
      c.clone_id,
      opts.reason ?? 'manual stop',
    );
    await rt.ctx.events.append({
      type: 'daemon_stop',
      clone_id: c.clone_id,
      payload: { reason: opts.reason ?? 'manual stop' },
    });
  }
  opts.reporter.info('daemon.stop', { count: daemonClones.length });
  return {
    exitCode: 0,
    stdout: `Stopped ${daemonClones.length} daemon clone(s).`,
  };
}
