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
  let cursor = 0;
  const deadline = opts.rt.ctx.clock.now() + opts.durationMs;
  let cloneSeenOnce = false;
  const notFoundGraceMs = 10_000;
  const notFoundDeadline = opts.rt.ctx.clock.now() + notFoundGraceMs;

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
      cursor = Math.max(cursor, event.ts);
    }

    try {
      const record = await opts.rt.ctx.registry.get(opts.cloneId);
      cloneSeenOnce = true;
      if (record.state === 'DEAD') {
        opts.onLine(`--- clone ${opts.cloneId} is DEAD: ${record.death_reason ?? 'unknown'} ---`);
        break;
      }
    } catch (err) {
      if (err instanceof BusNotFoundError) {
        if (!cloneSeenOnce && opts.rt.ctx.clock.now() >= notFoundDeadline) {
          throw new CliError(`clone "${opts.cloneId}" not found after ${notFoundGraceMs / 1000}s`, {
            kind: 'not_found',
            cause: err,
          });
        }
      } else {
        throw err;
      }
    }

    await sleep(opts.intervalMs, opts.signal);
  }
}
