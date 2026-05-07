import type { Runtime } from '../runtime.js';
import { renderStatusTable } from '../output/status-table.js';
import type { Reporter } from '../output/reporter.js';

export interface CommandResult {
  exitCode: number;
  stdout: string;
}

export interface RunStatusOptions {
  reporter: Reporter;
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
  const stdout = renderStatusTable(status);
  opts.reporter.info('status', {
    clones: status.clones.length,
    locks: status.locks.length,
    claims: status.claims.length,
  });
  return { exitCode: 0, stdout };
}
