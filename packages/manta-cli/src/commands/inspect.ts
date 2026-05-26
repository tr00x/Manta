import type { Runtime } from '../runtime.js';
import type { Reporter } from '../output/reporter.js';
import type { CommandResult } from './status.js';
import { BusNotFoundError } from '@manta/bus';
import { CliError } from '../errors.js';
import { renderInspect, type InspectOutput } from '../output/inspect-renderer.js';

export interface RunInspectOptions {
  cloneId: string;
  json: boolean;
  eventCount: number;
  reporter: Reporter;
}

export async function runInspectCommand(
  rt: Runtime,
  opts: RunInspectOptions,
): Promise<CommandResult> {
  let clone;
  try {
    clone = await rt.ctx.registry.get(opts.cloneId);
  } catch (err) {
    if (err instanceof BusNotFoundError) {
      throw new CliError(`clone "${opts.cloneId}" not found in registry`, {
        kind: 'not_found',
        cause: err,
      });
    }
    throw err;
  }

  const [contract, locks, allClaims, allEvents] = await Promise.all([
    rt.ctx.contracts.read(opts.cloneId).catch((err) =>
      err instanceof BusNotFoundError ? null : Promise.reject(err),
    ),
    rt.ctx.locks.listOwned(opts.cloneId),
    rt.ctx.claims.list(),
    rt.ctx.events.readAll(),
  ]);

  const claims = allClaims.filter((c) => c.owner_clone_id === opts.cloneId);
  const cloneEvents = allEvents
    .filter((e) => e.clone_id === opts.cloneId)
    .slice(-Math.min(opts.eventCount, 100));

  const heartbeatAgeMs = rt.ctx.clock.now() - clone.last_heartbeat_at;
  const data: InspectOutput = {
    clone,
    contract,
    locks,
    claims,
    recentEvents: cloneEvents,
    liveness: {
      heartbeatAgeMs,
      stale: heartbeatAgeMs > rt.thresholds.heartbeatTimeoutMs,
      thresholdMs: rt.thresholds.heartbeatTimeoutMs,
    },
  };

  const stdout = opts.json
    ? JSON.stringify(data, null, 2)
    : renderInspect(data);

  opts.reporter.info('inspect', { cloneId: opts.cloneId, state: clone.state });
  return { exitCode: 0, stdout };
}
