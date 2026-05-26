import type { Runtime } from '../runtime.js';
import type { Reporter } from '../output/reporter.js';
import type { CommandResult } from './status.js';
import { BusNotFoundError } from '@manta/bus';
import { reconstructTimeline, renderReplayMarkdown, renderReplayJson } from '@manta/orchestrator';
import { CliError } from '../errors.js';

export interface RunReplayOptions {
  castId: string;
  format: 'markdown' | 'json';
  cloneIds?: string[];
  since?: number;
  reporter: Reporter;
}

export async function runReplayCommand(
  rt: Runtime,
  opts: RunReplayOptions,
): Promise<CommandResult> {
  let timeline;
  try {
    timeline = await reconstructTimeline(rt.ctx, opts.castId, {
      cloneId: opts.cloneIds?.[0],
      since: opts.since,
    });
  } catch (err) {
    if (err instanceof BusNotFoundError) {
      throw new CliError(`cast "${opts.castId}" not found`, {
        kind: 'not_found',
        cause: err,
      });
    }
    throw err;
  }

  const stdout =
    opts.format === 'json'
      ? JSON.stringify(renderReplayJson(timeline), null, 2)
      : renderReplayMarkdown(timeline);

  opts.reporter.info('replay', { castId: opts.castId, events: timeline.events.length });
  return { exitCode: 0, stdout };
}
