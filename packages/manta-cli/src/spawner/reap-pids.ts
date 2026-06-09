/**
 * Shared OS-process reaping for the operator stop verbs (`manta abort`, `manta
 * kill`, `manta recover`).
 *
 * Bug #65: marking a clone DEAD in the registry does NOT stop its `claude
 * --print` OS process. A clone whose parent `manta cast` process has exited is
 * reparented to init, so a *separate* operator command can only reach it via
 * the clone's OWN recorded pid (`clone_pid`) — the parent's process group is
 * gone. This helper SIGTERMs every target, waits the grace once, then SIGKILLs
 * the survivors, so an aborted/killed/recovered clone is actually stopped, not
 * just relabelled.
 */

import { isProcessAlive } from '@manta/orchestrator';

/** Injectable OS-signal seam (default: real `process.kill`). Tests stub it. */
export type KillFn = (pid: number, signal: NodeJS.Signals) => void;

export const realKill: KillFn = (pid, signal) => {
  process.kill(pid, signal);
};

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const DEFAULT_GRACEFUL_MS = 5_000;

export interface ReapTarget {
  /** The OS pid to signal. */
  pid: number;
  /**
   * `true` → signal the process GROUP (negative pid) first, falling back to the
   * bare pid. Reaps a still-live parent's whole clone tree (incl. `claude`'s MCP
   * server grandchildren). Use for `manta abort`, which stops everything.
   *
   * `false` → signal ONLY the bare pid. Use when targeting one clone (`manta
   * kill <id>`, `recover` orphan sweep) so a sibling clone — or a still-running
   * cast process sharing the parent's group — is never collaterally killed.
   */
  group: boolean;
}

export interface ReapOptions {
  /** Override the OS kill seam (tests). Defaults to `process.kill`. */
  kill?: KillFn;
  /** Sleep seam (tests pass a no-op to skip the real grace wait). */
  sleep?: (ms: number) => Promise<void>;
  /** Grace, in ms, between the SIGTERM sweep and the SIGKILL sweep. Default 5000. */
  gracefulMs?: number;
  /**
   * Liveness probe, RE-checked immediately before each SIGKILL (skeptic-review
   * #65-1). Defaults to the real `process.kill(pid, 0)` probe. After SIGTERM +
   * grace, a target that already exited has freed its pid — blindly SIGKILLing
   * it could hit an unrelated process the OS recycled the pid to. Re-probing
   * skips the SIGKILL for any pid no longer alive, shrinking the reuse window
   * from the full grace to ~microseconds. Tests pass `() => true` since their
   * fake pids are "alive" in the test's model.
   */
  isAlive?: (pid: number) => boolean;
}

/**
 * Signal one target once. Swallows every error: a process that already exited
 * (ESRCH) or whose pid was reused must never abort the reap. Refuses pid <= 1
 * (init / whole system) and our own process (self-kill).
 */
function signalOne(target: ReapTarget, signal: NodeJS.Signals, kill: KillFn): void {
  const { pid, group } = target;
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return;
  if (group) {
    try {
      kill(-pid, signal); // negative pid = the process group
      return;
    } catch {
      // not a group leader (or group already gone) — fall through to bare pid
    }
  }
  try {
    kill(pid, signal);
  } catch {
    // already gone / reused — nothing left to signal
  }
}

/**
 * SIGTERM every (deduped) target, wait the grace once, then SIGKILL every
 * survivor. Returns the count of distinct targets it attempted to signal.
 */
export async function reapPids(
  targets: ReapTarget[],
  opts: ReapOptions = {},
): Promise<number> {
  const kill = opts.kill ?? realKill;
  const sleep = opts.sleep ?? realSleep;
  const gracefulMs = opts.gracefulMs ?? DEFAULT_GRACEFUL_MS;
  const isAlive = opts.isAlive ?? isProcessAlive;

  const seen = new Set<string>();
  const valid = targets.filter((t) => {
    if (!Number.isInteger(t.pid) || t.pid <= 1 || t.pid === process.pid) return false;
    const key = `${t.group ? '-' : ''}${t.pid}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (valid.length === 0) return 0;

  for (const t of valid) signalOne(t, 'SIGTERM', kill);
  await sleep(gracefulMs);
  // Re-probe before SIGKILL (#65-1): a target that exited on SIGTERM has freed
  // its pid; SIGKILLing it could land on whatever the OS recycled the pid to.
  for (const t of valid) {
    if (isAlive(t.pid)) signalOne(t, 'SIGKILL', kill);
  }
  return valid.length;
}
