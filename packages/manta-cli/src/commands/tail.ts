import type { Runtime } from '../runtime.js';
import type { Reporter } from '../output/reporter.js';
import type { CommandResult } from './status.js';
import { BusNotFoundError } from '@manta/bus';
import { CliError } from '../errors.js';
import { sleep } from '../util/sleep.js';
import { formatTailEvent, formatTailEventRaw } from '../output/tail-formatter.js';

export interface RunTailOptions {
  cloneId: string;
  durationMs: number;
  intervalMs: number;
  raw: boolean;
  reporter: Reporter;
}

export async function runTailCommand(
  rt: Runtime,
  opts: RunTailOptions,
): Promise<CommandResult> {
  // H3: a NaN/garbage --duration must not disarm the deadline. A non-finite
  // (or non-positive) deadline makes `now() >= deadline` forever false, so the
  // poll loop never terminates and tails forever (burning the session). The
  // documented 10s user minimum is enforced at the CLI boundary (bin/manta.ts),
  // which errors instead of silently clamping; this guard is the loop's own
  // defence against an unfinite/zero deadline from any caller.
  if (!Number.isFinite(opts.durationMs) || opts.durationMs <= 0) {
    throw new CliError(
      `tail duration must be a finite, positive number of ms (got ${opts.durationMs})`,
      { kind: 'invalid_input' },
    );
  }

  // M2: validate the clone exists in the registry UP FRONT and fail fast. The
  // previous design only checked existence inside the poll loop, guarded by a
  // 10s grace window (notFoundDeadline) — but that deadline raced the main
  // duration deadline, and the top-of-loop `now >= deadline` break is evaluated
  // first. With the CLI's 10s minimum duration the two deadlines coincide, so
  // the loop broke (exit 0) before the not-found throw ever fired:
  // `manta tail <nonexistentCloneId>` streamed nothing for ~10s then reported
  // success. The spawner registers a clone on the bus BEFORE launching it, so
  // any id a user can name is already registered; a miss is a genuine "no such
  // clone", not a startup race. Reject it with exit 1.
  try {
    await rt.ctx.registry.get(opts.cloneId);
  } catch (err) {
    if (err instanceof BusNotFoundError) {
      throw new CliError(`no such clone "${opts.cloneId}"`, {
        kind: 'not_found',
        cause: err,
      });
    }
    throw err;
  }

  const lines: string[] = [];
  const ctrl = new AbortController();

  const onLine = (line: string): void => {
    lines.push(line);
  };

  await runTailLoop({
    rt,
    cloneId: opts.cloneId,
    durationMs: opts.durationMs,
    intervalMs: opts.intervalMs,
    raw: opts.raw,
    signal: ctrl.signal,
    onLine,
  });

  opts.reporter.info('tail', { cloneId: opts.cloneId, lines: lines.length });
  return { exitCode: 0, stdout: lines.join('\n') };
}

interface TailLoopOptions {
  rt: Runtime;
  cloneId: string;
  durationMs: number;
  intervalMs: number;
  raw: boolean;
  signal: AbortSignal;
  onLine: (line: string) => void;
}

async function runTailLoop(opts: TailLoopOptions): Promise<void> {
  // Event-id cursor (not ts): '' sorts before any real id, so the first poll
  // sees all history; advancing by id keeps same-ms events (bug #42).
  let cursor = '';
  const deadline = opts.rt.ctx.clock.now() + opts.durationMs;

  for (;;) {
    if (opts.signal.aborted) break;
    if (opts.rt.ctx.clock.now() >= deadline) break;

    const events = await opts.rt.ctx.events.readSince(cursor);
    const filtered = events.filter((e) => e.clone_id === opts.cloneId);

    for (const event of filtered) {
      const line = opts.raw
        ? formatTailEventRaw(event)
        : formatTailEvent(event);
      opts.onLine(line);
      if (event.id > cursor) cursor = event.id;
    }

    try {
      const record = await opts.rt.ctx.registry.get(opts.cloneId);
      if (record.state === 'DEAD') {
        opts.onLine(`--- clone ${opts.cloneId} is DEAD: ${record.death_reason ?? 'unknown'} ---`);
        break;
      }
    } catch (err) {
      if (err instanceof BusNotFoundError) {
        // Existence was already validated before the loop (runTailCommand). A
        // mid-stream miss means the record was reaped while we watched — there
        // is nothing left to stream, so stop cleanly rather than spin.
        opts.onLine(`--- clone ${opts.cloneId} is gone (registry record removed) ---`);
        break;
      }
      throw err;
    }

    await sleep(opts.intervalMs, opts.signal);
  }
}
