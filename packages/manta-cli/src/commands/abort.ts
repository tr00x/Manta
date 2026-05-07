import type { Runtime } from '../runtime.js';
import type { Reporter } from '../output/reporter.js';
import type { CommandResult } from './status.js';
import { fsPostMortemWriter, runPostMortem } from '@manta/orchestrator';

export interface RunAbortOptions {
  reason: string;
  reporter: Reporter;
}

/**
 * `manta abort` — mark every non-DEAD clone DEAD and write a post-mortem each.
 *
 * Already-DEAD clones are left alone (preserving their original death_reason).
 * `runPostMortem` does the actual markDead+artifact write atomically; the
 * abort event is appended after each clone's post-mortem so a partial failure
 * leaves a clean audit trail.
 */
export async function runAbortCommand(
  rt: Runtime,
  opts: RunAbortOptions,
): Promise<CommandResult> {
  const all = await rt.ctx.registry.list();
  const live = all.filter((c) => c.state !== 'DEAD');
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
