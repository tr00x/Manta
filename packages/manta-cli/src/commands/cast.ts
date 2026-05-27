import type { Runtime } from '../runtime.js';
import type { Reporter } from '../output/reporter.js';
import type { CommandResult } from './status.js';
import type { Mode, Snapshot } from '@manta/snapshot';
import type {
  CastPolicy,
  CloneAssignment,
  TaskContract as BusTaskContract,
} from '@manta/bus';
import type { CloneRunner, CloneHandle } from '../spawner/clone-spawner.js';
import { spawnClone } from '../spawner/clone-spawner.js';
import { addWorktree, removeWorktree, type WorktreeRecord } from '../spawner/worktree.js';
import { buildCloneSnapshot } from '../spawner/snapshot-builder.js';
import { runTickLoop } from '../tick-loop.js';
import { CliError } from '../errors.js';
import { verifyMantaBusRegistered } from './mcp-preflight.js';
import { loadScoringConfig, runMergeReview, Orchestrator, makeProbe, fsPostMortemWriter, ForensicTimelineWriter, type BusContext as MergeReviewBusContext } from '@manta/orchestrator';
import { join } from 'node:path';
import { createMetricCollector } from './merge-review-collector.js';
import { adjustWeightsFromProject } from './rubric-prepass.js';
import { listWorktrees } from '../spawner/worktree.js';
import { loadBudgetConfig } from '../config/budget-config.js';
import { runPreSpawnGate } from '../budget/pre-spawn-gate.js';
import { classifyCastOutcome } from '../budget/cast-outcome.js';

// Phase 2a: forking-realities joins recon-swarm. Spec Sec 2 #2; see
// docs/research/phase-2-codepath-map.md §1.1 for the per-mode capability
// table deferral note (Phase 4+).
const SUPPORTED_MODES: ReadonlySet<Mode> = new Set<Mode>([
  'recon-swarm',
  'forking-realities',
  'bug-hunt',
]);
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
  /**
   * Per-clone task / approach / scope / budget overlay. Keys are clone_id strings
   * (must be a subset of the spawn roster — keys for clones not in the roster
   * cause invalid_input). Values override the cast-level defaults for that clone
   * only; missing fields fall back to cast-level. Optional — if omitted, every
   * clone receives the cast-level defaults.
   */
  cloneAssignments?: Record<string, CloneAssignment>;
  runner: CloneRunner;
  reporter: Reporter;
  /** Skip the `claude mcp list` pre-flight. Tests with fake runners pass false. */
  verifyMcp?: boolean;
  /** Daily cap override (CLI: --daily-cap-usd). If undefined, reads from BudgetConfig. */
  dailyCapUsdOverride?: number;
  /** Skip charge system check (CLI: --no-charge-check). Default false. */
  noChargeCheck?: boolean;
  /** Force past daily cap (CLI: --force). Default false. */
  force?: boolean;
  /** Dry-run mode: print cost preview, do not spawn (CLI: --dry-run). Default false. */
  dryRun?: boolean;
}

const DEFAULT_SCOPE: CastScopeOptions = {
  allowedPaths: ['.'],
  forbiddenPaths: ['.manta/state', 'secrets/'],
  maxFilesChanged: 0,
};

interface EffectiveAssignment {
  task: string;
  approachHint: string | null;
  scope: CastScopeOptions;
  budgetUsd: number;
  deadlineMs: number;
}

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
 * Phase-2a invariants:
 *   - Modes allowlisted: `recon-swarm`, `forking-realities`.
 *   - cloneCount is bounded 1..5.
 *   - Cumulative cost gate: Σ(per-clone effective budget) ≤ budget-per-cast.
 */
export async function runCastCommand(
  rt: Runtime,
  opts: RunCastOptions,
): Promise<CommandResult> {
  if (!SUPPORTED_MODES.has(opts.mode)) {
    throw new CliError(
      `mode "${opts.mode}" is not supported (allowed: ${[...SUPPORTED_MODES].join(', ')})`,
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
  if (opts.mode === 'bug-hunt' && opts.cloneCount > 2) {
    throw new CliError(
      'bug-hunt mode supports at most 2 clones (spec Sec 2)',
      { kind: 'invalid_input' },
    );
  }

  const cloneIds = CLONE_NAMES.slice(0, opts.cloneCount);
  const assignments = opts.cloneAssignments ?? {};

  // Reject any assignment key not in the roster — operator typo guard. The
  // roster is fixed by --clones (Phase 0 ceiling = 5), so a key like 'Z' or
  // 'clone-A' (different naming convention) flags up before we waste a worktree.
  for (const id of Object.keys(assignments)) {
    if (!cloneIds.includes(id)) {
      throw new CliError(
        `cloneAssignments key "${id}" is not a member of the spawn roster (${cloneIds.join(', ')})`,
        { kind: 'invalid_input' },
      );
    }
  }

  // Cast-level scope validation runs once up front; the overlay either inherits
  // this or overrides scope per-clone. Per-clone scopes are validated by zod
  // (ScopeSchema) during parseTasksFile, so we only check the cast-level fall-
  // back here.
  const castScope = opts.scope ?? DEFAULT_SCOPE;
  if (
    !Number.isInteger(castScope.maxFilesChanged) ||
    castScope.maxFilesChanged < 0
  ) {
    throw new CliError(
      `--max-files-changed must be a non-negative integer; got ${castScope.maxFilesChanged}`,
      { kind: 'invalid_input' },
    );
  }
  if (castScope.allowedPaths.length === 0) {
    throw new CliError(
      `--allowed-paths must list at least one path (default ".")`,
      { kind: 'invalid_input' },
    );
  }

  // Compute per-clone effective overlay (task / approach / scope / budget /
  // deadline). Each field falls back to the cast-level default when the
  // assignment omits it. Cumulative budget gate is Σ effective per-clone caps,
  // not N×cap — asymmetric overrides are honoured.
  const effective: Record<string, EffectiveAssignment> = {};
  let totalBudgetUsd = 0;
  for (const id of cloneIds) {
    const a = assignments[id] ?? {};
    const e: EffectiveAssignment = {
      task: a.task ?? opts.task,
      approachHint: a.approach_hint ?? null,
      scope: a.scope
        ? {
            allowedPaths: a.scope.allowed_paths,
            forbiddenPaths: a.scope.forbidden_paths,
            maxFilesChanged: a.scope.max_files_changed,
          }
        : castScope,
      budgetUsd: a.budget_usd ?? opts.budgetUsdPerClone,
      deadlineMs:
        a.deadline_seconds != null ? a.deadline_seconds * 1_000 : DEFAULT_DEADLINE_MS,
    };
    effective[id] = e;
    totalBudgetUsd += e.budgetUsd;
  }

  if (totalBudgetUsd > opts.budgetUsdPerCast) {
    const detail = cloneIds
      .map((id) => `${id}=$${effective[id]!.budgetUsd}`)
      .join(' + ');
    throw new CliError(
      `cumulative budget (${detail} = $${totalBudgetUsd}) exceeds --budget-per-cast-usd=$${opts.budgetUsdPerCast}. ` +
        `Reduce per-clone budgets, lower --budget-per-clone-usd, or raise --budget-per-cast-usd.`,
      { kind: 'invalid_input' },
    );
  }

  // Phase 3: Pre-spawn gate (charge + daily budget + dry-run)
  const budgetConfig = await loadBudgetConfig(rt.repoRoot);
  const gateResult = await runPreSpawnGate({
    mode: opts.mode,
    cloneCount: opts.cloneCount,
    castId: opts.castId,
    budgetUsdPerClone: opts.budgetUsdPerClone,
    budgetUsdPerCast: opts.budgetUsdPerCast,
    dailyCapUsdOverride: opts.dailyCapUsdOverride,
    force: opts.force ?? false,
    noChargeCheck: opts.noChargeCheck ?? false,
    dryRun: opts.dryRun ?? false,
    config: budgetConfig,
    charges: rt.ctx.charges,
    dailySpend: rt.ctx.dailySpend,
    reporter: opts.reporter,
  });

  if (!gateResult.passed) {
    throw new CliError(
      `Pre-spawn gate failed for ${opts.mode} × ${opts.cloneCount}`,
      { kind: 'budget_gate_failed' },
    );
  }

  if (opts.dryRun) {
    return {
      exitCode: 0,
      stdout: `Dry run complete for cast ${opts.castId}. No clones spawned.`,
    };
  }

  // MCP pre-flight unless explicitly skipped (tests with fake runners pass
  // verifyMcp=false). Defaults to ON for production safety.
  if (opts.verifyMcp !== false) {
    await verifyMantaBusRegistered();
  }

  const handles: CloneHandle[] = [];
  const worktrees: WorktreeRecord[] = [];

  // Mode-aware policy. Recorded on the manifest now; Phase 2b enforces
  // peer_messaging at the bus surface.
  const castPolicy: CastPolicy =
    opts.mode === 'forking-realities'
      ? { peer_messaging: 'denied', auto_merge_threshold: null }
      : { peer_messaging: 'allowed', auto_merge_threshold: null };

  // Roster carries the per-clone CloneAssignment if one exists (forking-
  // realities) or null otherwise (recon-swarm). Phase 2c merge-review reads
  // it via CastsStore.read; Phase 2b filter only consumes policy + clone_ids.
  const castRoster = cloneIds.map((id) => ({
    clone_id: id,
    assignment: assignments[id] ?? null,
  }));

  try {
    for (const cloneId of cloneIds) {
      const e = effective[cloneId]!;
      const wt = await addWorktree({
        repoRoot: rt.repoRoot,
        name: `clone-${cloneId}`,
        branch: `manta/${opts.castId}/${cloneId}`,
      });
      worktrees.push(wt);
      const snap = buildCloneSnapshot({
        cloneId,
        mode: opts.mode,
        task: e.task,
        // snapshot.Scope uses camelCase (allowedPaths/forbiddenPaths/maxFilesChanged);
        // the bus's TaskContractSchema uses snake_case. We translate at the
        // ctx.contracts.write boundary below.
        scope: {
          allowedPaths: e.scope.allowedPaths,
          forbiddenPaths: e.scope.forbiddenPaths,
          maxFilesChanged: e.scope.maxFilesChanged,
        },
        approachHint: e.approachHint,
        siblingClones: cloneIds.filter((id) => id !== cloneId),
        deadlineMs: e.deadlineMs,
        parentWorktree: rt.repoRoot,
        cloneWorktree: wt.path,
        parentPid: process.pid,
        // Phase 0 has no real session-id concept yet; the cast id is unique
        // and serves the same role for snapshot identity. Phase 1+ replaces
        // this with a real Claude-Code session id when daemon-mode lands.
        parentSessionId: opts.castId,
        castId: opts.castId,
        budgetUsd: e.budgetUsd,
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
        casts: rt.ctx.casts,
        castMode: opts.mode,
        castPolicy,
        castRoster,
      });
      handles.push(handle);
      opts.reporter.info('cast.spawn', { cloneId, worktree: wt.path });
    }

    const startedAt = rt.ctx.clock.now();
    const timelinePath = join(
      rt.repoRoot,
      rt.thresholds.timelinesDir,
      `${opts.castId}.ndjson`,
    );
    const timeline = new ForensicTimelineWriter(timelinePath, {
      cast_id: opts.castId,
      mode: opts.mode,
      started_at: startedAt,
    });
    const castOrchestrator = new Orchestrator({
      ctx: rt.ctx,
      thresholds: rt.thresholds,
      probe: makeProbe(),
      writer: fsPostMortemWriter({
        repoRoot: rt.repoRoot,
        postMortemDir: rt.thresholds.postMortemDir,
      }),
      timeline,
    });

    const ctrl = new AbortController();
    const budgetTimer = setTimeout(() => ctrl.abort(), opts.tickBudgetMs);
    let loopResult;
    try {
      loopResult = await runTickLoop({
        orchestrator: castOrchestrator,
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
    await timeline.seal(rt.ctx.clock.now());

    // Phase 3: Post-cast settlement
    if (!(opts.noChargeCheck ?? false)) {
      const allClones = await rt.ctx.registry.list();
      const castClones = allClones.filter((c) => cloneIds.includes(c.clone_id));
      const outcome = classifyCastOutcome({
        clones: castClones,
        budgetAborted: loopResult.aborted,
      });

      switch (outcome) {
        case 'success':
          await rt.ctx.charges.creditSuccess(opts.castId, opts.mode);
          break;
        case 'fail':
          await rt.ctx.charges.creditFail(opts.castId, opts.mode);
          break;
        case 'neutral':
          await rt.ctx.charges.creditNeutral(opts.castId, opts.mode);
          break;
      }

      opts.reporter.info('cast.settlement', {
        cast: opts.castId,
        outcome,
        charges: (await rt.ctx.charges.read()).current_charges,
      });
    }

    if (opts.mode === 'bug-hunt' && !loopResult.aborted) {
      opts.reporter.info('cast.bug-hunt-complete', {
        cast: opts.castId,
        hint: 'Use manta inspect <cloneId> to review investigation reports',
      });
    } else if (opts.mode === 'forking-realities' && !loopResult.aborted) {
      try {
        const config = await loadScoringConfig(rt.repoRoot);
        const { config: adjustedConfig, adjustments } = await adjustWeightsFromProject(rt.repoRoot, config);
        const collector = createMetricCollector();
        const allEvents = await rt.ctx.events.readAll();
        const allWorktrees = await listWorktrees({ repoRoot: rt.repoRoot });

        const candidates = await Promise.all(
          cloneIds.map(async (id) => {
            const expectedBranch = `manta/${opts.castId}/${id}`;
            const wt = allWorktrees.find((w) => w.branch === expectedBranch);
            const wtPath = wt?.path ?? `${rt.repoRoot}/.manta/worktrees/clone-${id}`;
            const collected = await collector.collect(id, wtPath, 'main');
            const certEvent = allEvents.find(
              (e) =>
                e.clone_id === id &&
                e.type === 'broadcast' &&
                (e.payload as Record<string, unknown> | null)?.event_type === 'self_certainty',
            );
            const selfCertainty = certEvent
              ? ((certEvent.payload as Record<string, unknown> | null)?.score as number) ?? null
              : null;
            return { ...collected, selfCertainty };
          }),
        );

        await runMergeReview(rt.ctx as unknown as MergeReviewBusContext, {
          castId: opts.castId,
          candidates,
          config: adjustedConfig,
          weightAdjustments: adjustments,
          writer: rt.mergeReviewWriter,
        });
        opts.reporter.info('cast.merge_review', { cast: opts.castId });
      } catch (err) {
        opts.reporter.info('cast.merge_review_failed', {
          cast: opts.castId,
          error: (err as Error)?.message ?? String(err),
        });
      }
    }

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
 *
 * @internal — exported for contract-drift tests in tests/commands/cast.test.ts.
 * Not part of the public CLI surface; do not import from outside this package.
 */
export function toBusContract(snap: Snapshot): BusTaskContract {
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
