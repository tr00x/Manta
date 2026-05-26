import type { Runtime } from '../runtime.js';
import type { Reporter } from '../output/reporter.js';
import type { CommandResult } from './status.js';
import { BusNotFoundError } from '@manta/bus';
import { buildAuditLog, renderAuditMarkdown, renderAuditJson } from '@manta/orchestrator';
import { CliError } from '../errors.js';

export interface RunAuditOptions {
  cloneId: string;
  format: 'markdown' | 'json';
  typeFilter?: string[];
  since?: number;
  limit?: number;
  gaps?: boolean;
  gapThreshold?: number;
  reporter: Reporter;
}

export async function runAuditCommand(
  rt: Runtime,
  opts: RunAuditOptions,
): Promise<CommandResult> {
  let log;
  try {
    log = await buildAuditLog(rt.ctx, opts.cloneId, {
      typeFilter: opts.typeFilter,
      since: opts.since,
      limit: opts.limit,
      gapThresholdMs: opts.gapThreshold != null ? opts.gapThreshold * 1_000 : undefined,
    });
  } catch (err) {
    if (err instanceof BusNotFoundError) {
      throw new CliError(`clone "${opts.cloneId}" not found`, {
        kind: 'not_found',
        cause: err,
      });
    }
    throw err;
  }

  const stdout =
    opts.format === 'json'
      ? JSON.stringify(renderAuditJson(log), null, 2)
      : renderAuditMarkdown(log);

  opts.reporter.info('audit', { cloneId: opts.cloneId, entries: log.entries.length });
  return { exitCode: 0, stdout };
}
