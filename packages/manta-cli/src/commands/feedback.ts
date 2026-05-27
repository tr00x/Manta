import type { Runtime } from '../runtime.js';
import type { Reporter } from '../output/reporter.js';
import type { CommandResult } from './status.js';
import { CliError } from '../errors.js';

export interface FeedbackOptions {
  cloneId: string;
  message: string;
  severity: 'info' | 'correction' | 'blocker';
  reporter: Reporter;
}

export async function runFeedbackCommand(
  rt: Runtime,
  opts: FeedbackOptions,
): Promise<CommandResult> {
  const record = await rt.ctx.registry.get(opts.cloneId).catch(() => null);
  if (!record) {
    throw new CliError(`clone not found: ${opts.cloneId}`, {
      kind: 'not_found',
    });
  }

  await rt.ctx.events.append({
    type: 'feedback',
    clone_id: opts.cloneId,
    payload: {
      from: 'main',
      feedback: opts.message,
      severity: opts.severity,
    },
  });
  opts.reporter.info('feedback', { cloneId: opts.cloneId, severity: opts.severity });
  return { exitCode: 0, stdout: `Feedback sent to clone ${opts.cloneId}.` };
}
