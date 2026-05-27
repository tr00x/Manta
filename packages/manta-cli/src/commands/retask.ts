import type { Runtime } from '../runtime.js';
import type { Reporter } from '../output/reporter.js';
import type { CommandResult } from './status.js';
import { CliError } from '../errors.js';

export interface RetaskOptions {
  cloneId: string;
  task: string;
  reporter: Reporter;
}

export async function runRetaskCommand(
  rt: Runtime,
  opts: RetaskOptions,
): Promise<CommandResult> {
  const record = await rt.ctx.registry.get(opts.cloneId).catch(() => null);
  if (!record) {
    throw new CliError(`clone not found: ${opts.cloneId}`, {
      kind: 'not_found',
    });
  }
  if (record.state !== 'IDLE' && record.state !== 'WAITING_FOR_TASK') {
    throw new CliError(
      `cannot retask clone ${opts.cloneId} in state ${record.state}; must be IDLE or WAITING_FOR_TASK`,
      { kind: 'retask_failed' },
    );
  }

  await rt.ctx.events.append({
    type: 'retask',
    clone_id: opts.cloneId,
    payload: { new_task: opts.task, source: 'cli' },
  });

  if (rt.ctx.workQueue) {
    await rt.ctx.workQueue.enqueue({
      cast_id: record.metadata?.cast_id ?? 'unknown',
      target_clone_id: opts.cloneId,
      prompt: opts.task,
      priority: 'normal',
    });
  }

  opts.reporter.info('retask', { cloneId: opts.cloneId });
  return { exitCode: 0, stdout: `Re-tasked clone ${opts.cloneId}.` };
}
