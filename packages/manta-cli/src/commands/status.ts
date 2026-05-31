import type { Runtime } from '../runtime.js';
import { renderStatusTable } from '../output/status-table.js';
import type { Reporter } from '../output/reporter.js';

export interface CommandResult {
  exitCode: number;
  stdout: string;
}

export interface RunStatusOptions {
  reporter: Reporter;
  /** Include settled (DEAD) clones in the table (CLI `--all`). Default false. */
  showAll?: boolean;
}

/**
 * `manta status` — render a snapshot of active clones, locks, and claims.
 *
 * Pure read against the orchestrator's `getStatus`; never mutates state. Exit
 * code is always 0 (the orchestrator surfaces no failure modes here — torn
 * reads are tolerated upstream in `buildStatus`).
 */
export async function runStatusCommand(
  rt: Runtime,
  opts: RunStatusOptions,
): Promise<CommandResult> {
  const status = await rt.orchestrator.getStatus();
  const stdout = renderStatusTable(status, { showAll: opts.showAll ?? false });
  const liveCount = status.clones.filter((c) => c.state !== 'DEAD').length;
  opts.reporter.info('status', {
    clones: liveCount,
    settled: status.clones.length - liveCount,
    locks: status.locks.length,
    claims: status.claims.length,
  });
  return { exitCode: 0, stdout };
}
