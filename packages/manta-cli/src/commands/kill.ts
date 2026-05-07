import type { Runtime } from '../runtime.js';
import type { Reporter } from '../output/reporter.js';
import type { CommandResult } from './status.js';
import { CliError } from '../errors.js';
import { fsPostMortemWriter, runPostMortem } from '@manta/orchestrator';

export interface RunKillOptions {
  cloneId: string;
  reason: string;
  reporter: Reporter;
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
