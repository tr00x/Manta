import type { Orchestrator, CycleResult } from '@manta/orchestrator';
import { CliError } from './errors.js';
import { sleep } from './util/sleep.js';

export interface RunTickLoopOptions {
  orchestrator: Orchestrator;
  intervalMs: number;
  allDone: () => Promise<boolean>;
  signal?: AbortSignal;
  daemonMode?: boolean;
  onCycleComplete?: (result: CycleResult) => Promise<void>;
}

export interface TickLoopResult {
  cycles: number;
  aborted: boolean;
  daemonResumeCycles?: number;
}

export async function runTickLoop(opts: RunTickLoopOptions): Promise<TickLoopResult> {
  let cycles = 0;
  let aborted = false;
  for (;;) {
    if (opts.signal?.aborted) {
      aborted = true;
      break;
    }
    let result: CycleResult;
    try {
      result = await opts.orchestrator.runCycle();
    } catch (err) {
      throw new CliError('orchestrator cycle failed', {
        kind: 'orchestrator_failed',
        cause: err,
      });
    }
    if (opts.onCycleComplete) {
      await opts.onCycleComplete(result);
    }
    cycles += 1;
    if (await opts.allDone()) break;
    await sleep(opts.intervalMs, opts.signal);
  }
  return { cycles, aborted };
}
