import type { Runtime } from '../runtime.js';
import type { Reporter } from '../output/reporter.js';
import type { CommandResult } from './status.js';
import type { Mode, Snapshot } from '@manta/snapshot';
import type { TaskContract as BusTaskContract } from '@manta/bus';
import type { CloneRunner, CloneHandle } from '../spawner/clone-spawner.js';
import { spawnClone } from '../spawner/clone-spawner.js';
import { addWorktree, removeWorktree, type WorktreeRecord } from '../spawner/worktree.js';
import { buildCloneSnapshot } from '../spawner/snapshot-builder.js';
import { runTickLoop } from '../tick-loop.js';
import { CliError } from '../errors.js';
import { verifyMantaBusRegistered } from './mcp-preflight.js';

const SUPPORTED_MODES: ReadonlySet<Mode> = new Set<Mode>(['recon-swarm']);
const CLONE_NAMES: readonly string[] = ['A', 'B', 'C', 'D', 'E']; // Phase 0 ceiling = 5
const DEFAULT_DEADLINE_MS = 1_200_000; // 20 min per spec Sec 6.2

export interface CastScopeOptions {
  /** Paths the clone may read/write within (relative to repo root). */
  allowedPaths: string[];
  /** Paths the clone MUST NOT touch. */
  forbiddenPaths: string[];
  /** Hard cap on file writes per clone. 0 = read-only. Bug #6: must be >0 for deliverable casts. */
  maxFilesChanged: number;
}

export interface RunCastOptions {
  mode: Mode;
  task: string;
  cloneCount: number;
  cycleIntervalMs: number;
  tickBudgetMs: number;
  castId: string;
  budgetUsdPerClone: number;
  budgetUsdPerCast: number;
  /**
   * Per-clone scope (allowed/forbidden paths, max files changed). Optional —
   * when omitted defaults to read-only whole-repo with `.manta/state` and
   * `secrets/` forbidden (existing pre-bug-#6 behaviour preserved for tests).
   */
  scope?: CastScopeOptions;
  runner: CloneRunner;
  reporter: Reporter;
  /** Skip the `claude mcp list` pre-flight. Tests with fake runners pass false. */
  verifyMcp?: boolean;
}

const DEFAULT_SCOPE: CastScopeOptions = {
  allowedPaths: ['.'],
  forbiddenPaths: ['.manta/state', 'secrets/'],
  maxFilesChanged: 0,
};

/**
 * `manta cast <mode>` — orchestrate a full cast lifecycle:
 *   1. Validate mode + cloneCount + cumulative cost gate.
 *   2. (Optional) MCP pre-flight — confirm manta-bus registered with Claude.
 *   3. For each clone: create worktree, build snapshot, write task contract,
 *      spawn the runner.
 *   4. Tick the orchestrator until all spawned clones are DEAD or the
 *      tick-budget elapses.
 *   5. Reap surviving subprocesses (best effort), emit summary.
 *
 * Phase-0 invariants:
 *   - Only `recon-swarm` mode is supported (other modes throw invalid_input).
 *   - cloneCount is bounded 1..5.
 *   - Cumulative cost gate: cloneCount × per-clone-USD ≤ per-cast-USD.
 */
export async function runCastCommand(
  rt: Runtime,
  opts: RunCastOptions,
): Promise<CommandResult> {
  if (!SUPPORTED_MODES.has(opts.mode)) {
    throw new CliError(
      `mode "${opts.mode}" is not supported in Phase 0 (only recon-swarm)`,
      { kind: 'invalid_input' },
    );
  }
  if (
    !Number.isInteger(opts.cloneCount) ||
    opts.cloneCount < 1 ||
    opts.cloneCount > 5
  ) {
    throw new CliError(
      `cloneCount must be an integer in 1..5; got ${opts.cloneCount}`,
      { kind: 'invalid_input' },
    );
  }

  // Cumulative cost gate (Phase-0 interim; Phase 3 ledger replaces). Per-clone
  // budget × clone count must not exceed the per-cast cap. Defaults
  // (5 × clones, 15 cap) reject 4+ clones — operator must explicitly opt in.
  const totalBudgetUsd = opts.cloneCount * opts.budgetUsdPerClone;
  if (totalBudgetUsd > opts.budgetUsdPerCast) {
    throw new CliError(
      `cumulative budget (cloneCount=${opts.cloneCount} × $${opts.budgetUsdPerClone} = $${totalBudgetUsd}) ` +
        `exceeds --budget-per-cast-usd=$${opts.budgetUsdPerCast}. ` +
        `Reduce --clones, lower --budget-per-clone-usd, or raise --budget-per-cast-usd.`,
      { kind: 'invalid_input' },
    );
  }

  // MCP pre-flight unless explicitly skipped (tests with fake runners pass
  // verifyMcp=false). Defaults to ON for production safety.
  if (opts.verifyMcp !== false) {
    await verifyMantaBusRegistered();
  }

  const scope = opts.scope ?? DEFAULT_SCOPE;
  if (
    !Number.isInteger(scope.maxFilesChanged) ||
    scope.maxFilesChanged < 0
  ) {
    throw new CliError(
      `--max-files-changed must be a non-negative integer; got ${scope.maxFilesChanged}`,
      { kind: 'invalid_input' },
    );
  }
  if (scope.allowedPaths.length === 0) {
    throw new CliError(
      `--allowed-paths must list at least one path (default ".")`,
      { kind: 'invalid_input' },
    );
  }

  const cloneIds = CLONE_NAMES.slice(0, opts.cloneCount);
  const handles: CloneHandle[] = [];
  const worktrees: WorktreeRecord[] = [];

  try {
    for (const cloneId of cloneIds) {
      const wt = await addWorktree({
        repoRoot: rt.repoRoot,
        name: `clone-${cloneId}`,
        branch: `manta/${opts.castId}/${cloneId}`,
      });
      worktrees.push(wt);
      const snap = buildCloneSnapshot({
        cloneId,
        mode: opts.mode,
        task: opts.task,
        // snapshot.Scope uses camelCase (allowedPaths/forbiddenPaths/maxFilesChanged);
        // the bus's TaskContractSchema uses snake_case. We translate at the
        // ctx.contracts.write boundary below.
        scope: {
          allowedPaths: scope.allowedPaths,
          forbiddenPaths: scope.forbiddenPaths,
          maxFilesChanged: scope.maxFilesChanged,
        },
        siblingClones: cloneIds.filter((id) => id !== cloneId),
        deadlineMs: DEFAULT_DEADLINE_MS,
        parentWorktree: rt.repoRoot,
        cloneWorktree: wt.path,
        parentPid: process.pid,
        // Phase 0 has no real session-id concept yet; the cast id is unique
        // and serves the same role for snapshot identity. Phase 1+ replaces
        // this with a real Claude-Code session id when daemon-mode lands.
        parentSessionId: opts.castId,
        castId: opts.castId,
        budgetUsd: opts.budgetUsdPerClone,
      });

      // Translate snapshot.taskContract (camelCase) → bus.TaskContract
      // (snake_case). This is the documented seam between the two schemas:
      // @manta/snapshot models the in-memory contract that travels with the
      // clone, @manta/bus models the on-disk wire format. They use the same
      // semantic fields under different names so a clone can read its
      // contract via MCP regardless of how the parent built it.
      const busContract = toBusContract(snap);
      await rt.ctx.contracts.write(busContract);

      const handle = await spawnClone({
        repoRoot: rt.repoRoot,
        snapshot: snap,
        worktree: wt.path,
        runner: opts.runner,
        registry: rt.ctx.registry,
      });
      handles.push(handle);
      opts.reporter.info('cast.spawn', { cloneId, worktree: wt.path });
    }

    const ctrl = new AbortController();
    const budgetTimer = setTimeout(() => ctrl.abort(), opts.tickBudgetMs);
    let loopResult;
    try {
      loopResult = await runTickLoop({
        orchestrator: rt.orchestrator,
        intervalMs: opts.cycleIntervalMs,
        signal: ctrl.signal,
        allDone: async () => {
          const all = await rt.ctx.registry.list();
          const ours = all.filter((c) => cloneIds.includes(c.clone_id));
          // Either every spawned clone is registered AND DEAD, or the tick
          // hasn't seen registrations yet (race window before clone subprocess
          // writes its registry record).
          if (ours.length < cloneIds.length) return false;
          return ours.every((c) => c.state === 'DEAD');
        },
      });
    } finally {
      clearTimeout(budgetTimer);
    }

    // I-IMP-3 (Chunk-2 review): if the loop exited via budget-abort, surviving
    // children may still be running (e.g. wedged `claude --print`, or the
    // `hang` test fake). Awaiting `h.exit` directly would hang forever. Force-
    // terminate them with the same SIGTERM→SIGKILL ladder the failure path
    // uses, so the budget-abort guarantees an upper bound on cast wall-time.
    if (loopResult.aborted) {
      opts.reporter.info('cast.budget_abort', {
        cast: opts.castId,
        cycles: loopResult.cycles,
      });
      await Promise.all(
        handles.map(async (h) => {
          try {
            await h.terminate({ gracefulMs: 1_000 });
          } catch {
            /* already exited */
          }
        }),
      );
    }

    // Final reap regardless of how the loop exited. The exit promise might
    // throw spawn_failed (I-1 fix); swallow per-clone errors here so the
    // surviving siblings still get reaped.
    await Promise.all(
      handles.map(async (h) => {
        try {
          await h.exit;
        } catch {
          /* already surfaced as cast_failed if it mattered */
        }
      }),
    );
    opts.reporter.info('cast.done', {
      cast: opts.castId,
      clones: cloneIds.length,
    });
    return {
      exitCode: 0,
      stdout: `Cast ${opts.castId} complete: ${cloneIds.length} clone(s).`,
    };
  } catch (err) {
    // Best-effort terminate of any running children; SIGTERM with SIGKILL
    // escalation (I-5) so a hung clone can't block the failure path.
    await Promise.all(
      handles.map(async (h) => {
        try {
          await h.terminate({ gracefulMs: 1_000 });
        } catch {
          /* already exited */
        }
      }),
    );
    // I-IMP-1 (Chunk-2 review): on the failure path, peel back any worktrees
    // created so a re-cast doesn't collide on `clone-${id}` paths or
    // `manta/${castId}/${id}` branch names. Successful casts intentionally
    // retain worktrees (operator post-mortem inspection — see ARCHITECTURE.md
    // "Worktrees stay after a cast"); failure paths must clean up. Order:
    // children terminated first (above), then their worktrees torn down.
    // Per-worktree errors are swallowed — best-effort cleanup; if git can't
    // remove one, surfacing it would mask the original cast_failed cause.
    await Promise.all(
      worktrees.map(async (wt) => {
        try {
          await removeWorktree({
            repoRoot: rt.repoRoot,
            worktreePath: wt.path,
            branch: wt.branch,
          });
        } catch {
          /* best-effort: leave worktree behind rather than swallow original err */
        }
      }),
    );
    if (err instanceof CliError) throw err;
    throw new CliError('cast failed', { kind: 'cast_failed', cause: err });
  }
  // Note: worktree cleanup is deliberately NOT done here. Phase 0 keeps the
  // `clone-${id}` worktrees on disk so the operator can `cd` in and inspect
  // post-mortem state. `manta abort` and Phase 7 `manta exhume` will manage
  // retention.
}

/**
 * Translate a snapshot's TaskContract (camelCase) into the bus's
 * TaskContract (snake_case). Centralized here so a future snapshot-schema
 * drift surfaces as a single edit instead of N call-sites. The unit drift
 * (snapshot.deadlineSeconds vs bus.deadline_ms) is the only non-mechanical
 * conversion.
 */
function toBusContract(snap: Snapshot): BusTaskContract {
  const tc = snap.taskContract;
  const deadlineMs = tc.deadlineSeconds * 1_000;
  const base = {
    clone_id: tc.cloneId,
    mode: tc.mode,
    task: tc.task,
    scope: {
      allowed_paths: tc.scope.allowedPaths,
      forbidden_paths: tc.scope.forbiddenPaths,
      max_files_changed: tc.scope.maxFilesChanged,
    },
    sibling_clones: tc.siblingClones,
    deadline_ms: deadlineMs,
  };
  if (tc.approachHint !== null) {
    return { ...base, approach_hint: tc.approachHint } as BusTaskContract;
  }
  return base as BusTaskContract;
}
