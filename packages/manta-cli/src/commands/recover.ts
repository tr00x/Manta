import type { Runtime } from '../runtime.js';
import type { Reporter } from '../output/reporter.js';
import type { CommandResult } from './status.js';
import { CliError } from '../errors.js';
import { sweepOrphanWorktrees } from '../spawner/graveyard.js';

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
  // Bug #43 fix: reconcile physical worktrees against the registry. Worktrees
  // under `.manta/worktrees/` whose path is NOT referenced by any current
  // CloneRecord are orphans (manual rm, partial teardown, registry was
  // wiped between casts). Sweep them so disk + git-worktree-metadata don't
  // accumulate across casts. Failures are non-fatal — surfaced in the
  // reporter so the operator can investigate without breaking recovery.
  const allClones = await rt.ctx.registry.list();
  const knownPaths = new Set(allClones.map((c) => c.worktree));
  let sweep: { removed: string[]; failed: Array<{ path: string; error: string }> } = { removed: [], failed: [] };
  try {
    sweep = await sweepOrphanWorktrees({
      repoRoot: rt.repoRoot,
      isKnown: (wt) => knownPaths.has(wt.path),
    });
  } catch (err) {
    // Sweep failure is not fatal for recover — the bus state was already
    // recovered above. Log and continue so the operator at least sees the
    // detected/reaped counts.
    opts.reporter.warn('recover.worktree_sweep_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  opts.reporter.info('recover', {
    deadDetected: result.deadClones.length,
    locksReaped: result.reapedLocks.length,
    claimsReaped: result.reapedClaims.length,
    postMortems: result.postMortems.length,
    orphanWorktreesRemoved: sweep.removed.length,
    orphanWorktreesFailed: sweep.failed.length,
  });
  const stdout = [
    `Recovery complete:`,
    `  ${result.deadClones.length} dead clone(s) detected`,
    `  ${result.reapedLocks.length} stale lock(s) reaped`,
    `  ${result.reapedClaims.length} expired claim(s) reaped`,
    `  ${result.postMortems.length} post-mortem(s) written`,
    `  ${sweep.removed.length} orphan worktree(s) removed`,
    ...(sweep.failed.length > 0
      ? [`  ${sweep.failed.length} orphan worktree(s) failed to remove (see warnings)`]
      : []),
  ].join('\n');
  return { exitCode: 0, stdout };
}
