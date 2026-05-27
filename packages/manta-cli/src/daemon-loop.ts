import type { WorkQueueStore, WorkItem } from '@manta/bus';
import type { CloneRunner } from './spawner/clone-spawner.js';
import { runClaudeResume } from './spawner/clone-spawner.js';
import { sleep } from './util/sleep.js';

export interface DaemonLoopOptions {
  sessionId: string;
  cloneId: string;
  castId: string;
  worktree: string;
  workQueue: WorkQueueStore;
  appendSystemPrompt: string;
  env: Record<string, string>;
  pollIntervalMs: number;
  maxResumeFailures: number;
  maxEmptyPolls: number;
  signal?: AbortSignal;
  claudeBin?: string;
  /** Override for testing — replaces the default runClaudeResume runner. */
  runner?: CloneRunner;
  onCycleComplete?: (item: WorkItem) => Promise<void>;
}

export interface DaemonLoopResult {
  resumeCycles: number;
  itemsCompleted: string[];
  exitReason: 'no_work' | 'aborted' | 'max_failures';
}

export async function runDaemonLoop(
  opts: DaemonLoopOptions,
): Promise<DaemonLoopResult> {
  let resumeCycles = 0;
  let consecutiveFailures = 0;
  let emptyPolls = 0;
  const itemsCompleted: string[] = [];

  for (;;) {
    if (opts.signal?.aborted) {
      return { resumeCycles, itemsCompleted, exitReason: 'aborted' };
    }

    const item = await opts.workQueue.dequeue(opts.cloneId);
    if (!item) {
      emptyPolls++;
      if (emptyPolls >= opts.maxEmptyPolls) {
        return { resumeCycles, itemsCompleted, exitReason: 'no_work' };
      }
      await sleep(opts.pollIntervalMs, opts.signal);
      continue;
    }
    emptyPolls = 0;

    const runner = opts.runner ?? runClaudeResume({
      sessionId: opts.sessionId,
      claudeBin: opts.claudeBin,
    });
    const proc = runner.run({
      cwd: opts.worktree,
      env: opts.env,
      appendSystemPrompt: opts.appendSystemPrompt,
      prompt: item.prompt,
    });

    let exitResult: { exitCode?: number | null; failed?: boolean };
    try {
      exitResult = await proc;
    } catch (err) {
      exitResult = err as { exitCode?: number | null; failed?: boolean };
    }

    if (exitResult.failed && exitResult.exitCode == null) {
      consecutiveFailures++;
      if (consecutiveFailures >= opts.maxResumeFailures) {
        return { resumeCycles, itemsCompleted, exitReason: 'max_failures' };
      }
      continue;
    }

    await opts.workQueue.complete(item.id);
    itemsCompleted.push(item.id);
    resumeCycles++;
    consecutiveFailures = 0;

    if (opts.onCycleComplete) {
      await opts.onCycleComplete(item);
    }
  }
}
