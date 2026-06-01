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
import { spawnClone, selectCloneRunner } from '../spawner/clone-spawner.js';
import { forkParentSession } from '../spawner/session-fork.js';
import { propagateProjectInstructions } from '../spawner/project-instructions.js';
import {
  addWorktree,
  removeWorktree,
  cloneWorktreeName,
  cloneWorktreePath,
  type WorktreeRecord,
} from '../spawner/worktree.js';
import { buildCloneSnapshot } from '../spawner/snapshot-builder.js';
import { runTickLoop } from '../tick-loop.js';
import { CliError } from '../errors.js';
import { verifyMantaBusRegistered } from './mcp-preflight.js';
import { classifyCastOutcome } from './cast-outcome.js';
import { loadScoringConfig, runMergeReview, Orchestrator, makeProbe, fsPostMortemWriter, ensureSelfDeathPostMortems, ForensicTimelineWriter, type BusContext as MergeReviewBusContext } from '@manta/orchestrator';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createMetricCollector, prepareWorktreeForGate } from './merge-review-collector.js';
import { detectToolchain } from './toolchain.js';
import { adjustWeightsFromProject } from './rubric-prepass.js';
import { listWorktrees } from '../spawner/worktree.js';
import { loadBudgetConfig } from '../config/budget-config.js';
import { assertAghsUnlocked, resolveUnlockedAghsModes } from '../config/aghs-gate.js';
import type { DispatchEnqueuer } from '../dispatch/types.js';
import { PairDispatcher } from '../dispatch/pair-dispatch.js';
import { DocChaseDispatcher } from '../dispatch/doc-chase-dispatch.js';
import { TestStormDispatcher } from '../dispatch/test-storm-dispatch.js';
import { BroadcastReader } from '../dispatch/broadcast-reader.js';
import { ModeRegistry } from '../library/mode-registry.js';
import { verifyMantaVersionCompat, buildCompatErrorMessage } from '../library/compat.js';
import { verifyLibraryIntegrity, buildIntegrityErrorMessage } from '../library/integrity.js';
import { getMantaCliVersion } from '../library/cli-version.js';
import type { Lockfile } from '../library/lockfile.js';
import type { LocalStore } from '../library/local-store.js';
import { promises as fsPromises } from 'node:fs';

// Phase 2a: forking-realities joins recon-swarm. Spec Sec 2 #2; see
// docs/research/phase-2-codepath-map.md §1.1 for the per-mode capability
// table deferral note (Phase 4+). Renamed in Phase 7a from SUPPORTED_MODES
// to BUILTIN_MODES — these are now the seed set passed into ModeRegistry,
// which augments them with library-installed modes at cast invocation time.
const BUILTIN_MODES: ReadonlySet<Mode> = new Set<Mode>([
  'recon-swarm',
  'forking-realities',
  'bug-hunt',
  'refactor-wave',
  'pair-programming',
  'test-storm',
  'documentation-chase',
  // Phase 8: Aghanim's-locked safe modes (spec Sec 2 #9/#10, Sec 6.6). Present
  // in BUILTIN_MODES so the dispatcher recognises them, but gated by
  // assertAghsUnlocked below — a cast is rejected unless the operator opted in
  // via config/env. `phantom-lance` (#8) is intentionally absent: it stays
  // locked at the "not supported" check (separate, riskier cast).
  'decoy',
  'council',
]);

const DAEMON_MODES: ReadonlySet<Mode> = new Set<Mode>([
  'pair-programming',
  'test-storm',
  'documentation-chase',
]);

/**
 * Bug #21: registry states that signal "daemon clone is currently quiet,
 * waiting for the orchestrator to push work into the queue." Both IDLE and
 * WAITING_FOR_TASK are valid daemon-idle states (`packages/manta-bus/src/
 * state/registry.ts:193` and `manta-bus/src/schema.ts:25`). The cast loop's
 * `allDone` predicate must treat both equivalently; otherwise a daemon clone
 * that calls `manta.request_task` (entering WAITING_FOR_TASK per the priming
 * preamble in `spawner/priming.ts:53`) hangs the cast until budget abort.
 *
 * Exported for the regression test in `tests/commands/cast.test.ts`.
 */
export const DAEMON_IDLE_STATES: ReadonlySet<string> = new Set([
  'IDLE',
  'WAITING_FOR_TASK',
]);

const CLONE_NAMES: readonly string[] = ['A', 'B', 'C', 'D', 'E']; // Phase 0 ceiling = 5

/**
 * Bug #19: clone-name allocation must skip slots currently held by live clones
 * from concurrent casts. Without this, two parallel casts both try to register
 * `A` first and the second one fails on pre-register. Live = state !== 'DEAD'.
 * DEAD slots are overwritten by Registry.register (bug #16 fix).
 */
export async function allocateCloneIds(
  registry: { list(): Promise<Array<{ clone_id: string; state: string }>> },
  count: number,
): Promise<string[]> {
  const all = await registry.list();
  const taken = new Set(all.filter((r) => r.state !== 'DEAD').map((r) => r.clone_id));
  const available = CLONE_NAMES.filter((id) => !taken.has(id));
  if (available.length < count) {
    const liveDetail = Array.from(taken).join(', ') || '(none)';
    throw new CliError(
      `cannot allocate ${count} clone slot(s): only ${available.length} of ${CLONE_NAMES.length} ` +
        `letters are free (live: ${liveDetail}). Wait for the other cast to finish, ` +
        `or run \`manta abort\` to stop it.`,
      { kind: 'concurrent_cast_limit_reached' },
    );
  }
  return available.slice(0, count);
}

/**
 * RB1/bug #56 — resolve the REAL parent Claude session uuid for transcript
 * inheritance. Resolution order (Decision #5, locked):
 *   1. `--parent-session-id` flag (`opts.parentSessionId`)
 *   2. `MANTA_PARENT_SESSION_ID` env
 *   3. `CLAUDE_CODE_SESSION_ID` env (set in-process by Claude Code; the cast
 *      child inherits it)
 *   4. else → `null`, `resumeEnabled = false`, and a `reporter.warn`.
 *
 * We NEVER fabricate an id (the old `parentSessionId: opts.castId` stuffed a
 * cast id — the wrong kind of value, which was the root of bug #56). `null`
 * means "no parent session known → clone boots without transcript inheritance".
 *
 * Note: the env fallbacks live here (not as a commander default on the flag) on
 * purpose — baking `CLAUDE_CODE_SESSION_ID` into the flag default would let it
 * mask `MANTA_PARENT_SESSION_ID`, breaking Decision #5's precedence (and the
 * Chunk-5 e2e, which drives inheritance via `MANTA_PARENT_SESSION_ID`).
 */
export function resolveParentSessionId(
  opts: { castId: string; parentSessionId?: string | undefined },
  reporter: Pick<Reporter, 'warn'>,
  env: NodeJS.ProcessEnv = process.env,
): { parentSessionId: string | null; resumeEnabled: boolean } {
  const flag = opts.parentSessionId?.trim();
  const mantaEnv = env.MANTA_PARENT_SESSION_ID?.trim();
  const claudeEnv = env.CLAUDE_CODE_SESSION_ID?.trim();
  const resolved = flag || mantaEnv || claudeEnv || null;
  if (resolved === null) {
    reporter.warn('cast.parent_session.unresolved', {
      castId: opts.castId,
      message:
        'no parent Claude session id (--parent-session-id / MANTA_PARENT_SESSION_ID / ' +
        'CLAUDE_CODE_SESSION_ID all unset); clones boot without transcript inheritance',
    });
    return { parentSessionId: null, resumeEnabled: false };
  }
  return { parentSessionId: resolved, resumeEnabled: true };
}

const DEFAULT_DEADLINE_MS = 1_200_000; // 20 min per spec Sec 6.2

/**
 * RB1/bug #56 (Chunk 2): default transcript-fork size guard. Above this the
 * parent JSONL is not copied (Chunk 4 will distill); matches the
 * `--distill-threshold-bytes` commander default in `bin/manta.ts`.
 */
const DEFAULT_DISTILL_THRESHOLD_BYTES = 2_000_000;

/**
 * Build a ModeRegistry seeded with built-ins + every library mode declared
 * in the lockfile. Reads each library package's `manta-package.json` from
 * `~/.manta/library/<scope>/<name>/<version>/` to discover the host
 * dispatcher (`basedOn`) for each `contributes.modes[]` entry. Lockfile-only
 * (and lockfile-without-localstore) cases are tolerated — a missing install
 * dir is surfaced by the hash-pin verification path (Chunk 2 task 2.4), not
 * by mode registration.
 */
async function loadModeRegistry(
  rt: Pick<Runtime, 'lockfile' | 'localStore'>,
): Promise<ModeRegistry> {
  const registry = new ModeRegistry(BUILTIN_MODES);
  const lock = await rt.lockfile.read();
  if (!lock) return registry;
  for (const [packageName, entry] of Object.entries(lock.packages)) {
    if (entry.contributes.modes.length === 0) continue;
    const installDir = rt.localStore.pathFor(packageName, entry.version);
    let manifestRaw: string;
    try {
      manifestRaw = await fsPromises.readFile(join(installDir, 'manta-package.json'), 'utf8');
    } catch {
      // Install dir missing — leave library modes unregistered. Hash-pin
      // verification (Chunk 2) surfaces the missing-install case explicitly.
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifestRaw);
    } catch {
      continue;
    }
    const contributes =
      parsed !== null && typeof parsed === 'object'
        ? (parsed as { contributes?: { modes?: Array<{ name?: string; basedOn?: Mode }> } }).contributes
        : undefined;
    const modes = contributes?.modes ?? [];
    for (const modeName of entry.contributes.modes) {
      const match = modes.find((m) => m.name === modeName);
      if (!match || !match.basedOn) continue;
      registry.registerLibrary({
        name: modeName,
        basedOn: match.basedOn,
        packageName,
        packageVersion: entry.version,
      });
    }
  }
  return registry;
}

// Keep TypeScript happy: Lockfile and LocalStore are surface types reused by
// loadModeRegistry; ensure they aren't flagged as unused if the function
// shrinks in a future commit.
export type CastLockfile = Lockfile;
export type CastLocalStore = LocalStore;

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
  /**
   * Explicit `--parent-session-id <uuid>` flag value (RB1/bug #56). When set it
   * wins the resolution order in {@link resolveParentSessionId}. Undefined when
   * the operator relied on env (`MANTA_PARENT_SESSION_ID` / `CLAUDE_CODE_SESSION_ID`).
   */
  parentSessionId?: string | undefined;
  /**
   * `--force-full-transcript` (RB1/bug #56, Chunk 2). When set, the parent
   * transcript is forked regardless of size — the size guard is bypassed. Off
   * by default: Tier A is safe-by-default and never silently copies an 11.7 MB
   * transcript × N clones.
   */
  forceFullTranscript?: boolean | undefined;
  /**
   * `--distill-threshold-bytes <n>` (RB1/bug #56, Chunk 2). Parent transcripts
   * strictly larger than this skip the fork (Chunk 4 will distill instead).
   * Default 2 MB. A genuine numeric default — not an env-precedence tier — so
   * it is fine as a commander default (contrast the Chunk-1 flag-default trap).
   */
  distillThresholdBytes?: number | undefined;
  /**
   * `--no-inherit-instructions` opt-out. When undefined or true (the default),
   * the parent project's CLAUDE.md / CLAUDE.local.md are copied into each
   * clone's worktree (they are otherwise lost — gitignored files never enter a
   * worktree checkout). Set false to skip the copy.
   */
  inheritInstructions?: boolean | undefined;
  /**
   * Parallelism cap (CLI: `--max-parallel-clones`). The ONLY cast constraint:
   * Claude Code is a subscription, not pay-per-token, so this is the single
   * guard that protects the machine and the subscription rate limit. When set, a
   * cast whose cloneCount exceeds it is rejected before any clone spawns. When
   * undefined, the BudgetConfig default (`max_parallel_clones`) applies.
   */
  maxParallelClones?: number;
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
  /**
   * MCP pre-flight to run before spawning any clone. Defaults to
   * {@link verifyMantaBusRegistered}. Injectable so tests can drive the throw
   * path (bus-not-registered) deterministically without a real `claude` binary
   * on PATH. Only consulted when `verifyMcp !== false` and not a dry-run.
   */
  preflight?: () => Promise<void>;
  /** Dry-run mode: validate and report, do not spawn (CLI: --dry-run). Default false. */
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
  // Phase 7a: build the registry from built-ins + library entries in the
  // lockfile (if any), then check compat *before* validating the mode name.
  // Library modes register against the host dispatcher named by `basedOn`;
  // see docs/internals/mode-registry.md (Chunk 2 architecture note).
  const modeRegistry = await loadModeRegistry(rt);
  const lock = await rt.lockfile.read();
  const compat = verifyMantaVersionCompat(lock, getMantaCliVersion());
  if (!compat.ok) {
    throw new CliError(
      buildCompatErrorMessage({
        offendingPackage: compat.offendingPackage,
        offendingPackageRange: compat.offendingPackageRange,
        currentVersion: compat.currentVersion,
      }),
      { kind: 'invalid_input', exitCode: 16 },
    );
  }
  // Phase 7a Chunk 2 task 2.4: hash-pin verification per cast. Ordering is
  // load-registry → compat → integrity → mode-lookup (reviewer must-fix):
  // compat reports the actionable upgrade message before a tamper hint, and
  // tamper reports before "unknown mode" so the operator sees the on-disk
  // root cause first. See docs/internals/mode-registry.md for the rationale.
  const integrity = await verifyLibraryIntegrity(lock, rt.localStore);
  if (!integrity.ok) {
    const offendingEntry = lock?.packages[integrity.offendingPackage];
    throw new CliError(
      buildIntegrityErrorMessage({
        offendingPackage: integrity.offendingPackage,
        offendingVersion: offendingEntry?.version ?? '<unknown>',
        expected: integrity.expected,
        actual: integrity.actual,
      }),
      { kind: 'invalid_input', exitCode: 19 },
    );
  }
  if (!modeRegistry.has(opts.mode)) {
    const allModes = [
      ...modeRegistry.list().builtins,
      ...modeRegistry.list().library.map((e) => e.name),
    ];
    throw new CliError(
      `mode "${opts.mode}" is not supported (allowed: ${allModes.join(', ')})`,
      { kind: 'invalid_input' },
    );
  }
  // Library modes route through their host dispatcher (basedOn) — record the
  // library origin so the cast manifest captures both layers, then rewrite
  // the effective opts to use the host dispatcher mode for the rest of this
  // function. This is the minimum integration per the Phase 7a plan; richer
  // per-mode dispatcher overrides are deferred (clone-C §4.4).
  const libraryEntry = modeRegistry.resolveLibrary(opts.mode);
  const libraryModeName: string | null = libraryEntry ? opts.mode : null;
  if (libraryEntry) {
    opts.reporter.info('cast.library_mode_resolved', {
      libraryMode: opts.mode,
      basedOn: libraryEntry.basedOn,
      packageName: libraryEntry.packageName,
      packageVersion: libraryEntry.packageVersion,
    });
    opts = { ...opts, mode: libraryEntry.basedOn };
  }
  void libraryModeName;
  // Phase 8 — Aghanim's Scepter gate (spec Sec 6.6). Load the budget config
  // once here (reused by the pre-spawn gate below) and reject Aghs-locked modes
  // unless the operator unlocked them via config or MANTA_UNLOCK_AGHS. Runs
  // before cloneCount/per-mode validation so the actionable "enable in config"
  // message wins over a count complaint for a mode the operator can't use yet.
  const budgetConfig = await loadBudgetConfig(rt.repoRoot);
  assertAghsUnlocked(
    opts.mode,
    resolveUnlockedAghsModes(budgetConfig.aghsUnlocked, process.env),
  );
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
  // bug #M10: bug-hunt is investigation-only by design — its protocol drives
  // ack → investigate → broadcast findings → write a markdown report; it has NO
  // step that mutates source and commits. A contract that asks bug-hunt to
  // "convert/refactor/implement … and commit" stalls silently in the gap between
  // an investigation protocol and a mutation task (the clone investigates, emits
  // one finding, then has nothing left to do — yet looks healthy because the
  // booting-ticker keeps its heartbeat fresh). Warn at cast time so the
  // mode-mismatch is visible instead of a silent no-deliverable stall; the
  // modes that reliably mutate+commit are refactor-wave and pair-programming.
  // This is a non-blocking heads-up — bug-hunt MAY legitimately end "I found the
  // cause, here's the proposed patch" — so we warn, never reject.
  if (opts.mode === 'bug-hunt' && /\b(commit|convert|refactor|migrat|implement|rewrite|replace)\w*/i.test(opts.task)) {
    opts.reporter.warn('cast.mode_mismatch_warning', {
      mode: 'bug-hunt',
      hint:
        'bug-hunt produces an investigation report, not commits — its protocol never mutates+commits source. ' +
        'If you want clones to change code and commit, use refactor-wave (codemod across modules) or ' +
        'pair-programming (writer mutates+commits, reviewer gates). Casting bug-hunt anyway.',
    });
  }
  if (opts.mode === 'refactor-wave' && !opts.cloneAssignments) {
    throw new CliError(
      'refactor-wave requires --tasks with per-clone module assignments',
      { kind: 'invalid_input' },
    );
  }
  if (opts.mode === 'pair-programming' && opts.cloneCount !== 2) {
    throw new CliError(
      'pair-programming mode requires exactly 2 clones (writer + reviewer)',
      { kind: 'invalid_input' },
    );
  }
  if (opts.mode === 'test-storm' && (opts.cloneCount < 2 || opts.cloneCount > 3)) {
    throw new CliError(
      'test-storm mode requires 2-3 clones (spec Sec 2)',
      { kind: 'invalid_input' },
    );
  }
  // Phase 8: decoy drafts with at most 2 clones (spec Sec 2 #10 — "clones do
  // draft work"; mirrors bug-hunt's ≤2 ceiling). Main polishes the drafts, so a
  // big roster adds review load without proportional value.
  if (opts.mode === 'decoy' && opts.cloneCount > 2) {
    throw new CliError(
      'decoy mode supports at most 2 clones (spec Sec 2 #10)',
      { kind: 'invalid_input' },
    );
  }
  // Phase 8: council = wisdom of crowds. Spec Sec 2 #9 calls for 5 independent
  // proposers; the Phase-0 roster ceiling is 5, so 5 is the intended maximum.
  // Require ≥3 so "crowd" aggregation is meaningful (2 is a pair, not a
  // council). Operators wanting the full spec experience pass --clones 5.
  if (opts.mode === 'council' && (opts.cloneCount < 3 || opts.cloneCount > 5)) {
    throw new CliError(
      'council mode requires 3-5 clones (spec Sec 2 #9 — 5 independent proposers ideal, 3 minimum for a meaningful crowd)',
      { kind: 'invalid_input' },
    );
  }

  const cloneIds = await allocateCloneIds(rt.ctx.registry, opts.cloneCount);
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

  // Compute per-clone effective overlay (task / approach / scope / deadline).
  // Each field falls back to the cast-level default when the assignment omits it.
  const effective: Record<string, EffectiveAssignment> = {};
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
      deadlineMs:
        a.deadline_seconds != null ? a.deadline_seconds * 1_000 : DEFAULT_DEADLINE_MS,
    };
    effective[id] = e;
  }

  // The ONLY cast constraint: PARALLELISM. Claude Code is a subscription, not
  // pay-per-token, so there is no dollar/charge/cooldown/cast-rate budget — the
  // single guard that protects the machine and the subscription rate limit is
  // how many clone processes run at once. Runs before any clone spawns, so a
  // rejected cast leaves no trace. Bug #60 NaN-reject is preserved at the flag
  // boundary (parsePositiveIntOption).
  const parallelismCap = opts.maxParallelClones ?? budgetConfig.maxParallelClones;
  if (opts.cloneCount > parallelismCap) {
    throw new CliError(
      `parallelism cap exceeded: ${opts.cloneCount} clones requested but --max-parallel-clones=${parallelismCap}. ` +
        `Spawn fewer clones or raise the cap (Claude Code is subscription-based — running too many clones at once ` +
        `exhausts your usage/rate limit).`,
      { kind: 'invalid_input' },
    );
  }

  // Bug #31: every operator-typo guard belongs before any clone spawns, so a
  // refactor-wave partition typo aborts cleanly rather than mid-spawn.
  if (opts.mode === 'refactor-wave' && assignments) {
    validateDisjointPartitions(assignments);
  }

  // The MCP pre-flight runs before any clone spawns: a user whose bus is not
  // registered (e.g. plugin users hit by B1) gets a clean abort instead of a
  // half-spawned cast whose clones can't reach the bus. Skipped on --dry-run (no
  // live bus needed) and when verifyMcp is explicitly false (fake-runner tests).
  // Injectable so a test can drive the throw path without a real `claude` binary.
  if (opts.verifyMcp !== false && !(opts.dryRun ?? false)) {
    const preflight = opts.preflight ?? (() => verifyMantaBusRegistered());
    await preflight();
  }

  if (opts.dryRun) {
    return {
      exitCode: 0,
      stdout: `Dry run complete for cast ${opts.castId}. No clones spawned.`,
    };
  }

  const handles: CloneHandle[] = [];
  const worktrees: WorktreeRecord[] = [];

  const sessionMode = DAEMON_MODES.has(opts.mode) ? 'daemon' as const : 'batch' as const;

  // Mode-aware policy. Recorded on the manifest now; Phase 2b enforces
  // peer_messaging at the bus surface.
  // `council` clones propose INDEPENDENTLY (no peeking, no peer chatter) — same
  // messaging isolation as forking-realities, but without the auto-merge scorer
  // (the main aggregates the proposals by hand). `decoy` stays collaborative
  // (drafters may broadcast progress) like recon-swarm.
  const castPolicy: CastPolicy =
    (opts.mode === 'forking-realities' || opts.mode === 'refactor-wave' || opts.mode === 'council')
      ? { peer_messaging: 'denied', auto_merge_threshold: null, session_mode: sessionMode }
      : { peer_messaging: 'allowed', auto_merge_threshold: null, session_mode: sessionMode };

  // Roster carries the per-clone CloneAssignment if one exists (forking-
  // realities) or null otherwise (recon-swarm). Phase 2c merge-review reads
  // it via CastsStore.read; Phase 2b filter only consumes policy + clone_ids.
  const castRoster = cloneIds.map((id) => ({
    clone_id: id,
    assignment: assignments[id] ?? null,
  }));

  // Wave-2: assign roles for pair-programming and documentation-chase
  if (opts.mode === 'pair-programming') {
    effective[cloneIds[0]!]!.approachHint = effective[cloneIds[0]!]!.approachHint ?? 'writer';
    effective[cloneIds[1]!]!.approachHint = effective[cloneIds[1]!]!.approachHint ?? 'reviewer';
  }
  if (opts.mode === 'documentation-chase') {
    effective[cloneIds[0]!]!.approachHint = effective[cloneIds[0]!]!.approachHint ?? 'documenter';
  }
  if (opts.mode === 'test-storm') {
    effective[cloneIds[0]!]!.approachHint = effective[cloneIds[0]!]!.approachHint ?? 'coder';
    effective[cloneIds[1]!]!.approachHint = effective[cloneIds[1]!]!.approachHint ?? 'tester';
    if (cloneIds.length > 2) {
      effective[cloneIds[2]!]!.approachHint = effective[cloneIds[2]!]!.approachHint ?? 'fuzzer';
    }
  }
  // Phase 8: every decoy clone is a 'drafter', every council clone a 'proposer'
  // (homogeneous roles — unlike pair/test-storm's distinct slots). The priming
  // builder keys its mode-specific protocol block off the mode, and the hint
  // reinforces the role in the clone's contract.
  if (opts.mode === 'decoy') {
    for (const id of cloneIds) {
      effective[id]!.approachHint = effective[id]!.approachHint ?? 'drafter';
    }
  }
  if (opts.mode === 'council') {
    for (const id of cloneIds) {
      effective[id]!.approachHint = effective[id]!.approachHint ?? 'proposer';
    }
  }

  try {
    // test-storm: create ONE shared worktree for all clones
    let sharedWorktree: WorktreeRecord | null = null;
    if (opts.mode === 'test-storm') {
      sharedWorktree = await addWorktree({
        repoRoot: rt.repoRoot,
        name: `storm-${opts.castId}`,
        branch: `storm/${opts.castId}/work`,
      });
      worktrees.push(sharedWorktree);
    }

    // RB1/bug #56: resolve the real parent Claude session uuid ONCE per cast
    // (it's the same for every clone); a single warn fires if nothing resolves.
    const { parentSessionId, resumeEnabled } = resolveParentSessionId(opts, opts.reporter);

    for (const cloneId of cloneIds) {
      const e = effective[cloneId]!;

      let wt: WorktreeRecord;
      if (sharedWorktree) {
        wt = sharedWorktree;
      } else {
        wt = await addWorktree({
          repoRoot: rt.repoRoot,
          // bug #64: cast-scoped name so a clone letter freed by one cast and
          // reused by another can never alias the same dir on disk.
          name: cloneWorktreeName(opts.castId, cloneId),
          branch: `manta/${opts.castId}/${cloneId}`,
        });
        worktrees.push(wt);
      }

      const sessionId = sessionMode === 'daemon'
        ? `${opts.castId}-${cloneId}-${randomUUID()}`
        : undefined;

      // RB1/bug #56 (Chunk 2): fork the parent transcript into THIS clone's
      // worktree project dir so it can `--resume` it (Chunk 3) and boot as a
      // continuation of the parent conversation. Done after `wt.path` is known
      // and before the snapshot is built so the snapshot's `resumeEnabled`
      // reflects whether the fork actually succeeded. Per-clone: each clone
      // gets a private fork (distinct uuid in its own project dir).
      let cloneResumeEnabled = resumeEnabled;
      let forkedSessionId: string | undefined;
      if (resumeEnabled && parentSessionId !== null) {
        const fork = await forkParentSession({
          parentSessionId,
          parentCwd: rt.repoRoot,
          cloneCwd: wt.path,
          // --force-full-transcript bypasses the size guard entirely (copy the
          // full transcript no matter how large); otherwise the guard skips
          // above the threshold (Decision #4: safe-by-default).
          thresholdBytes: opts.forceFullTranscript
            ? Number.POSITIVE_INFINITY
            : opts.distillThresholdBytes ?? DEFAULT_DISTILL_THRESHOLD_BYTES,
        });
        if ('forkedSessionId' in fork) {
          forkedSessionId = fork.forkedSessionId;
        } else {
          // not_found or over_threshold → fall back to today's empty-context
          // behaviour (Decision #4). Chunk 4 turns over_threshold into distill.
          cloneResumeEnabled = false;
          opts.reporter.warn('cast.transcript_fork.skipped', {
            castId: opts.castId,
            cloneId,
            reason: fork.skipped,
            message:
              fork.skipped === 'over_threshold'
                ? 'parent transcript exceeds --distill-threshold-bytes; clone boots without transcript inheritance (pass --force-full-transcript to override)'
                : 'parent transcript not found on disk; clone boots without transcript inheritance',
          });
        }
      }

      // Project-instructions inheritance: a clone's worktree is a git checkout
      // whose git-toplevel is the worktree itself, and CLAUDE.md is commonly
      // gitignored — so the parent's project instructions never reach the clone
      // by upward search or by checkout. Copy them in explicitly (the other
      // half of warm-start beside transcript inheritance). Non-fatal: a missing
      // or unreadable CLAUDE.md must never abort a cast. Opt out with
      // --no-inherit-instructions.
      if (opts.inheritInstructions !== false) {
        try {
          const copied = await propagateProjectInstructions({
            parentRoot: rt.repoRoot,
            worktreePath: wt.path,
          });
          if (copied.length > 0) {
            opts.reporter.info('cast.project_instructions.copied', {
              castId: opts.castId,
              cloneId,
              files: copied,
            });
          }
        } catch (err) {
          opts.reporter.warn('cast.project_instructions.failed', {
            castId: opts.castId,
            cloneId,
            message: String(err),
          });
        }
      }

      const snap = buildCloneSnapshot({
        cloneId,
        mode: opts.mode,
        task: e.task,
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
        parentSessionId,
        resumeEnabled: cloneResumeEnabled,
        castId: opts.castId,
        sessionMode,
        sessionId,
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
        // RB1/bug #56 (Chunk 3, Decision #2): per-clone runner choice driven by
        // snapshot data — resume the forked transcript when available, else
        // fall back to today's `opts.runner` (no NODE_ENV branch).
        runner: selectCloneRunner({
          resumeEnabled: cloneResumeEnabled,
          forkedSessionId,
          fallback: opts.runner,
        }),
        registry: rt.ctx.registry,
        casts: rt.ctx.casts,
        castMode: opts.mode,
        castPolicy,
        castRoster,
      });
      handles.push(handle);
      opts.reporter.info('cast.spawn', { cloneId, worktree: wt.path });
    }

    // Wave-2: create mode-specific dispatchers
    let pairDispatcher: PairDispatcher | null = null;
    let stormDispatcher: TestStormDispatcher | null = null;

    if (opts.mode === 'pair-programming') {
      pairDispatcher = new PairDispatcher({
        writerCloneId: cloneIds[0]!,
        reviewerCloneId: cloneIds[1]!,
        castId: opts.castId,
        maxIterations: 5,
      });
    }

    if (opts.mode === 'test-storm') {
      stormDispatcher = new TestStormDispatcher({
        coderCloneId: cloneIds[0]!,
        testerCloneId: cloneIds[1]!,
        fuzzerCloneId: cloneIds.length > 2 ? cloneIds[2]! : cloneIds[1]!,
        castId: opts.castId,
        maxFixCycles: 3,
      });
    }

    // Wave-2: documentation-chase pre-populates work queue at cast start
    if (opts.mode === 'documentation-chase' && rt.ctx.workQueue) {
      const docCloneId = cloneIds[0]!;
      const items = DocChaseDispatcher.parseTaskIntoItems(
        opts.task,
        docCloneId,
        opts.castId,
      );
      for (const item of items) {
        await rt.ctx.workQueue.enqueue(item);
      }
      opts.reporter.info('cast.doc_chase_enqueued', { items: items.length });
    }

    // Wave-2: BroadcastReader + enqueuer for dispatch callbacks
    const needsDispatch = opts.mode === 'pair-programming' || opts.mode === 'test-storm';
    const broadcastReader = needsDispatch
      ? new BroadcastReader(opts.castId, rt.ctx.events)
      : null;
    const dispatchEnqueuer: DispatchEnqueuer | null = (rt.ctx.workQueue)
      ? {
          enqueue: async (target, prompt, priority) => {
            await rt.ctx.workQueue!.enqueue({
              cast_id: opts.castId,
              target_clone_id: target,
              prompt,
              priority: priority ?? 'normal',
            });
          },
        }
      : null;

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
        daemonMode: sessionMode === 'daemon',
        onCycleComplete: (broadcastReader && dispatchEnqueuer && (pairDispatcher || stormDispatcher))
          ? async (result) => {
              const broadcasts = await broadcastReader.readNew();
              const input = { idleClones: result.idleClones, broadcasts };
              if (pairDispatcher) {
                await pairDispatcher.onCycleComplete(input, dispatchEnqueuer);
              }
              if (stormDispatcher) {
                await stormDispatcher.onCycleComplete(input, dispatchEnqueuer);
              }
            }
          : undefined,
        allDone: async () => {
          if (pairDispatcher?.isDone) return true;
          if (stormDispatcher?.isDone) return true;
          const all = await rt.ctx.registry.list();
          const ours = all.filter((c) => cloneIds.includes(c.clone_id));
          if (ours.length < cloneIds.length) return false;
          if (sessionMode === 'batch') {
            return ours.every((c) => c.state === 'DEAD');
          }
          // Daemon mode: done when all clones are DEAD, OR all clones
          // are IDLE/DEAD with no pending work items in the queue.
          const allDead = ours.every((c) => c.state === 'DEAD');
          if (allDead) return true;
          const allIdleOrDead = ours.every(
            (c) => c.state === 'DEAD' || DAEMON_IDLE_STATES.has(c.state),
          );
          if (!allIdleOrDead) return false;
          // All idle — check if work queue is empty for each clone
          if (rt.ctx.workQueue) {
            for (const id of cloneIds) {
              const pending = await rt.ctx.workQueue.pending(id);
              if (pending.length > 0) return false;
            }
          }
          return true;
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
    } else {
      // Bug #40 fix: loop ended cleanly (allDone returned true), but the
      // orchestrator's reaper only marks DEAD in registry state — it does
      // NOT kill OS processes. A wedged `claude --print` that crossed
      // heartbeatTimeoutMs ends up DEAD-in-registry with the OS child still
      // running, so the unconditional `await h.exit` below would hang on
      // it forever (orphan zombie holding the worktree and emitting bus
      // calls that get rejected as DEAD). Walk the registry, find clones
      // owned by this cast whose state is DEAD, and force-terminate their
      // handles before the reap. h.terminate is idempotent on already-
      // exited children, so the live IDLE siblings are untouched.
      const allClones = await rt.ctx.registry.list();
      const deadIds = new Set(
        allClones
          .filter((c) => c.state === 'DEAD' && cloneIds.includes(c.clone_id))
          .map((c) => c.clone_id),
      );
      if (deadIds.size > 0) {
        await Promise.all(
          handles
            .filter((h) => deadIds.has(h.cloneId))
            .map(async (h) => {
              try {
                await h.terminate({ gracefulMs: 1_000 });
              } catch {
                /* already exited */
              }
            }),
        );
      }
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

    // Z1: write post-mortems for clones that self-reported death via the bus.
    // The orchestrator reaper skips clones already in DEAD state
    // (death-detector.ts), so a clone that exits cleanly through
    // manta-graceful-death (→ bus report_death → DEAD) is never post-mortem'd
    // by a cycle. Enumerate this cast's DEAD clones and back-fill any missing
    // post-mortem, reusing the same fsPostMortemWriter + runPostMortem the
    // reaper uses. Idempotent against post-mortems the reaper already wrote.
    {
      const postMortemDir = join(rt.repoRoot, rt.thresholds.postMortemDir);
      let existingFilenames: string[] = [];
      try {
        existingFilenames = await fsPromises.readdir(postMortemDir);
      } catch {
        /* directory not created yet — no prior post-mortems on disk */
      }
      const settlementPostMortems = await ensureSelfDeathPostMortems(rt.ctx, {
        cloneIds,
        writer: fsPostMortemWriter({
          repoRoot: rt.repoRoot,
          postMortemDir: rt.thresholds.postMortemDir,
        }),
        thresholds: rt.thresholds,
        existingFilenames,
      });
      for (const pm of settlementPostMortems.written) {
        opts.reporter.info('cast.settlement_post_mortem', {
          cast: opts.castId,
          path: pm.path,
        });
      }
    }

    // Settlement verdict: classify how the cast ended (success / fail / neutral)
    // from the clones' final death reasons and emit it as `cast.settlement`.
    // This is a pure status signal for the operator + tests — the charge/cooldown
    // crediting that used to live here was removed (Claude Code is
    // subscription-based, so there is nothing to debit/credit).
    {
      const allClones = await rt.ctx.registry.list();
      const castClones = allClones.filter((c) => cloneIds.includes(c.clone_id));
      const outcome = classifyCastOutcome({
        clones: castClones,
        aborted: loopResult.aborted,
      });
      opts.reporter.info('cast.settlement', {
        cast: opts.castId,
        outcome,
      });
    }

    if (opts.mode === 'bug-hunt' && !loopResult.aborted) {
      opts.reporter.info('cast.bug-hunt-complete', {
        cast: opts.castId,
        hint: 'Use manta inspect <cloneId> to review investigation reports',
      });
    } else if (opts.mode === 'refactor-wave' && !loopResult.aborted) {
      try {
        await runMergeAllPipeline(rt, opts, cloneIds);
      } catch (err) {
        opts.reporter.info('cast.merge-all-failed', {
          cast: opts.castId,
          error: (err as Error)?.message ?? String(err),
        });
      }
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
            const wtPath = wt?.path ?? cloneWorktreePath(rt.repoRoot, opts.castId, id);
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
    // created so a re-cast doesn't collide on `clone-${castId}-${id}` paths or
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
  } finally {
    // Bug #40 defensive last line: every cast exit path — happy return,
    // catch-rethrow, or any exception escaping both — must leave zero live
    // child processes behind. The catch above already terminates on error
    // (and does so BEFORE worktree removal, which order matters). The
    // happy-path block above terminates DEAD-but-OS-running clones. This
    // finally is the belt-and-suspenders pass that catches anything those
    // two paths missed (defensive guarantee, not a primary mechanism).
    // h.terminate is idempotent on already-exited children, so re-running
    // it on already-cleaned handles is a cheap no-op. Errors are swallowed
    // because finally must not throw and mask the original outcome.
    await Promise.all(
      handles.map(async (h) => {
        try {
          await h.terminate({ gracefulMs: 500 });
        } catch {
          /* already exited or termination raced */
        }
      }),
    );
  }
  // Note: worktree cleanup is deliberately NOT done here. Phase 0 keeps the
  // `clone-${castId}-${id}` worktrees on disk so the operator can `cd` in and inspect
  // post-mortem state. `manta abort` and Phase 7 `manta exhume` will manage
  // retention.
}

async function runMergeAllPipeline(
  rt: Runtime,
  opts: RunCastOptions,
  cloneIds: string[],
): Promise<void> {
  const { runMergeAll, fsMergeAllWriter, renderMergeAllMarkdown } = await import('@manta/orchestrator');
  const { execa } = await import('execa');

  const allWorktrees = await listWorktrees({ repoRoot: rt.repoRoot });
  const allClones = await rt.ctx.registry.list();
  const castClones = allClones
    .filter((c) => cloneIds.includes(c.clone_id) && c.state === 'DEAD')
    .sort((a, b) => (a.died_at ?? 0) - (b.died_at ?? 0));
  const deadClones = castClones.map((c) => {
    const expectedBranch = `manta/${opts.castId}/${c.clone_id}`;
    const wt = allWorktrees.find((w) => w.branch === expectedBranch);
    return {
      cloneId: c.clone_id,
      worktreePath: wt?.path ?? cloneWorktreePath(rt.repoRoot, opts.castId, c.clone_id),
      exitTime: c.died_at ?? Date.now(),
    };
  });

  const mergeResult = await runMergeAll({
    repoRoot: rt.repoRoot,
    castId: opts.castId,
    deadClones,
    async runQualityGate(worktreePath: string) {
      const errors: string[] = [];
      // bug #63: build the worktree before gating so the merge-all scorer mirrors
      // the canonical pre-merge gate (install + build, then typecheck + test)
      // instead of a build-naive check that reds on every `@manta/*` build-time
      // alias. Shared prepare = one source of truth.
      // bug #M9: the gate is fully toolchain-aware — both typecheck and test
      // come from the detected toolchain (pnpm/npm/pytest/cargo/go), so a non-JS
      // project no longer false-REDs on a missing `pnpm test`/`pnpm typecheck`.
      // A null command (axis not applicable) or a missing tool passes that axis
      // (nothing to fail). Only a command that runs AND exits non-zero fails.
      const tc = detectToolchain(worktreePath);
      await prepareWorktreeForGate(worktreePath);
      const diffRes = await execa('git', ['diff', '--stat', 'HEAD'], { cwd: worktreePath, reject: false });
      const hasDiff = diffRes.stdout.trim().length > 0;
      let tscOk = true;
      if (tc.typecheck) {
        const tscRes = await execa(tc.typecheck[0], [...tc.typecheck.slice(1)], {
          cwd: worktreePath,
          reject: false,
          timeout: 120_000,
        });
        // A missing tool (exitCode null + ENOENT) is a skip, not a failure.
        const toolMissing = tscRes.exitCode === null;
        tscOk = toolMissing || tscRes.exitCode === 0;
        if (!tscOk) errors.push(`typecheck: ${(tscRes.stderr || tscRes.stdout).slice(0, 200)}`);
      }
      let testsOk = true;
      if (tc.test) {
        const testRes = await execa(tc.test[0], [...tc.test.slice(1)], {
          cwd: worktreePath,
          reject: false,
          timeout: 300_000,
        });
        const toolMissing = testRes.exitCode === null;
        testsOk = toolMissing || testRes.exitCode === 0;
        if (!testsOk) errors.push(`tests: exit ${testRes.exitCode}`);
      }
      return { passed: tscOk && testsOk, hasDiff, tscOk, testsOk, errors };
    },
    async gitMerge(repoRoot: string, branch: string) {
      const res = await execa('git', ['merge', '--no-edit', branch], { cwd: repoRoot, reject: false });
      return { hasConflicts: res.exitCode !== 0 };
    },
    async gitMergeAbort(repoRoot: string) {
      await execa('git', ['merge', '--abort'], { cwd: repoRoot, reject: false });
    },
  });

  const writer = fsMergeAllWriter({ repoRoot: rt.repoRoot, mergeAllDir: 'docs/merge-all-reports' });
  const body = renderMergeAllMarkdown(mergeResult);
  await writer.write({ filename: `cast-${opts.castId}.md`, body });

  opts.reporter.info('cast.merge-all', {
    cast: opts.castId,
    verdict: mergeResult.verdict,
    merged: mergeResult.merged.join(', '),
  });
}

/**
 * Validate that per-clone allowedPaths partitions are disjoint — no exact
 * duplicates and no prefix containment (e.g. `src/auth/` vs `src/auth/login/`).
 * Throws CliError('invalid_input') on overlap.
 *
 * @internal — exported for unit tests in tests/commands/cast.test.ts.
 */
export function validateDisjointPartitions(
  assignments: Record<string, CloneAssignment>,
): void {
  const allPaths = new Map<string, string>();
  for (const [cloneId, assignment] of Object.entries(assignments)) {
    for (const p of assignment.scope?.allowed_paths ?? []) {
      const existing = allPaths.get(p);
      if (existing) {
        throw new CliError(
          `Overlapping partition: path "${p}" assigned to both ${existing} and ${cloneId}`,
          { kind: 'invalid_input' },
        );
      }
      allPaths.set(p, cloneId);
    }
  }
  const norm = (p: string): string => p.endsWith('/') ? p : `${p}/`;
  for (const [p1, c1] of allPaths) {
    for (const [p2, c2] of allPaths) {
      if (p1 !== p2 && c1 !== c2 && (norm(p1).startsWith(norm(p2)) || norm(p2).startsWith(norm(p1)))) {
        throw new CliError(
          `Nested partition overlap: "${p1}" (${c1}) and "${p2}" (${c2})`,
          { kind: 'invalid_input' },
        );
      }
    }
  }
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
