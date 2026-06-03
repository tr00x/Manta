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
  /**
   * #M14/#M11: the clone's minimal-MCP config, forwarded to the resume runner so
   * a resumed daemon turn keeps `--strict-mcp-config` isolation instead of
   * re-inheriting the operator's heavy user-scope stack (which wedges boot).
   */
  mcpConfigPath?: string;
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
      ...(opts.claudeBin !== undefined ? { claudeBin: opts.claudeBin } : {}),
    });
    const proc = runner.run({
      cwd: opts.worktree,
      env: opts.env,
      appendSystemPrompt: opts.appendSystemPrompt,
      prompt: item.prompt,
      // #M14/#M11: keep minimal-MCP isolation on every resumed turn.
      ...(opts.mcpConfigPath !== undefined ? { mcpConfigPath: opts.mcpConfigPath } : {}),
    });

    // #M11: a resumed turn is a child `claude --print` we own. If the cast
    // aborts mid-turn (budget cap, operator abort), kill it now rather than
    // leaving an orphan zombie holding the worktree (CLAUDE.md "catastrophic
    // incident" class). `await proc` itself does not observe the signal, so we
    // bridge the abort to a SIGTERM and detach the listener once the turn ends.
    const killOnAbort = (): void => {
      try {
        proc.kill('SIGTERM');
      } catch {
        // already exited
      }
    };
    opts.signal?.addEventListener('abort', killOnAbort, { once: true });
    if (opts.signal?.aborted) killOnAbort();

    let exitResult: { exitCode?: number | null; failed?: boolean };
    try {
      exitResult = await proc;
    } catch (err) {
      exitResult = err as { exitCode?: number | null; failed?: boolean };
    } finally {
      opts.signal?.removeEventListener('abort', killOnAbort);
    }

    if (exitResult.failed && exitResult.exitCode == null) {
      consecutiveFailures++;
      // Bug #27 fix: release the claimed item back to the queue so it can be
      // retried (by this clone on next poll or by another daemon clone).
      // Pre-fix, `continue` left the item with `claimed_at` set forever —
      // `dequeue` filters claimed items out, so the work was silently lost.
      // `release` clears `claimed_at`, increments `attempts`, and after
      // `maxAttempts` (default 3) marks the item `dead_letter: true` so a
      // genuinely-broken work item doesn't loop forever.
      try {
        await opts.workQueue.release(item.id);
      } catch {
        // Best-effort release: a failure here means the next poll sees the
        // item still claimed and waits it out via the existing `consecutive
        // Failures` budget. Don't mask the original runner failure.
      }
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
