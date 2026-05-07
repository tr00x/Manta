import type { Runtime } from '../runtime.js';
import type { Reporter } from '../output/reporter.js';
import type { CommandResult } from './status.js';
import { CliError } from '../errors.js';

export interface RunRecoverOptions {
  reporter: Reporter;
}

/**
 * `manta recover` — run a single orchestrator cycle.
 *
 * Surface for post-crash cleanup: detect stale heartbeats / orphan parents,
 * reap stale locks/claims, write post-mortems for any newly-dead clones.
 * Wraps `OrchestratorError` as `CliError(recovery_failed)` so the bin can map
 * to a typed exit code instead of a raw stack trace.
 */
export async function runRecoverCommand(
  rt: Runtime,
  opts: RunRecoverOptions,
): Promise<CommandResult> {
  let result;
  try {
    result = await rt.orchestrator.runCycle();
  } catch (err) {
    // CliErrorOptions.cause is `unknown` (errors.ts:11) so we pass `err`
    // through verbatim — whether it's an OrchestratorError or anything else,
    // the consumer reads it via `Error.cause`. (I-IMP-2: dropped a dead
    // `isOrchestratorError(err) ? err : err` ternary that branched to the
    // same value.)
    throw new CliError('orchestrator cycle failed during recover', {
      kind: 'recovery_failed',
      cause: err,
    });
  }
  opts.reporter.info('recover', {
    deadDetected: result.deadClones.length,
    locksReaped: result.reapedLocks.length,
    claimsReaped: result.reapedClaims.length,
    postMortems: result.postMortems.length,
  });
  const stdout = [
    `Recovery complete:`,
    `  ${result.deadClones.length} dead clone(s) detected`,
    `  ${result.reapedLocks.length} stale lock(s) reaped`,
    `  ${result.reapedClaims.length} expired claim(s) reaped`,
    `  ${result.postMortems.length} post-mortem(s) written`,
  ].join('\n');
  return { exitCode: 0, stdout };
}
