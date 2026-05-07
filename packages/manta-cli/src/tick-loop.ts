import type { Orchestrator } from '@manta/orchestrator';
import { CliError } from './errors.js';

export interface RunTickLoopOptions {
  orchestrator: Orchestrator;
  intervalMs: number;
  allDone: () => Promise<boolean>;
  signal?: AbortSignal;
}

export interface TickLoopResult {
  cycles: number;
  aborted: boolean;
}

export async function runTickLoop(opts: RunTickLoopOptions): Promise<TickLoopResult> {
  let cycles = 0;
  let aborted = false;
  for (;;) {
    if (opts.signal?.aborted) {
      aborted = true;
      break;
    }
    try {
      await opts.orchestrator.runCycle();
    } catch (err) {
      // CliErrorOptions.cause is `unknown` (errors.ts:11) so we forward `err`
      // verbatim — OrchestratorError or otherwise, it lands on `Error.cause`.
      // (I-IMP-2: removed a dead `isOrchestratorError(err) ? err : err`
      // ternary that returned the same value in both branches.)
      throw new CliError('orchestrator cycle failed', {
        kind: 'orchestrator_failed',
        cause: err,
      });
    }
    cycles += 1;
    if (await opts.allDone()) break;
    await sleep(opts.intervalMs, opts.signal);
  }
  return { cycles, aborted };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
