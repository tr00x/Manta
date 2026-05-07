import type { Orchestrator } from '@manta/orchestrator';
import { isOrchestratorError } from '@manta/orchestrator';
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
      throw new CliError('orchestrator cycle failed', {
        kind: 'orchestrator_failed',
        cause: isOrchestratorError(err) ? err : err,
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
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
