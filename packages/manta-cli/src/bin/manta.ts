#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Command } from 'commander';
import type { Thresholds } from '@manta/orchestrator';
import { createRuntime, type Runtime } from '../runtime.js';
import { runCastCommand } from '../commands/cast.js';
import { runStatusCommand } from '../commands/status.js';
import { runKillCommand } from '../commands/kill.js';
import { runAbortCommand } from '../commands/abort.js';
import { runRecoverCommand } from '../commands/recover.js';
import { runPromoteCommand } from '../commands/promote.js';
import { runInspectCommand } from '../commands/inspect.js';
import { runTailCommand } from '../commands/tail.js';
import { runReplayCommand } from '../commands/replay.js';
import { runAuditCommand } from '../commands/audit.js';
import { runCostCommand, normalizeCostPeriod } from '../commands/cost.js';
import { runChargesCommand } from '../commands/charges.js';
import { runDoctorCommand } from '../commands/doctor.js';
import { runRefreshCommand } from '../commands/refresh.js';
import { runLimitCommand } from '../commands/limit.js';
import { runDaemonStatusCommand, runDaemonStopCommand } from '../commands/daemon.js';
import { runRetaskCommand } from '../commands/retask.js';
import { runFeedbackCommand } from '../commands/feedback.js';
import { runInstallCommand, InstallError } from '../commands/install.js';
import { runBootstrap, formatBootstrapResult } from '../commands/bootstrap.js';
import { runShareCommand, ShareError } from '../commands/share.js';
import { runUninstallCommand, UninstallError } from '../commands/uninstall.js';
import { runCleanupCommand, formatCleanupResult } from '../commands/cleanup.js';
import {
  runLibraryListCommand,
  runLibraryShowCommand,
  runLibraryOutdatedCommand,
  runLibraryDoctorCommand,
  createDefaultLibraryNetworkRunner,
  LibraryError,
  type LibraryListItem,
  type OutdatedReportItem,
} from '../commands/library.js';
import { createDefaultNetworkRunner, createRegistryClient } from '../library/registry-client.js';
import { getMantaCliVersion } from '../library/cli-version.js';
import { runClaudeCli } from '../spawner/clone-spawner.js';
import { parseTasksFile } from '../spawner/tasks-file.js';
import {
  parsePositiveIntOption,
  parseNonNegativeIntOption,
} from './option-parsers.js';
import { createReporter, StderrSink } from '../output/reporter.js';
import { CliError, isCliError } from '../errors.js';
import { renderTopLevelError } from './error-render.js';
import type { CommandResult } from '../commands/status.js';
import type { Mode } from '@manta/snapshot';
import type { CloneAssignment } from '@manta/bus';

/**
 * Run a command body inside a freshly composed Runtime. Uses
 * `process.exitCode` instead of `process.exit()` so the event loop drains
 * naturally — that lets `rt.dispose()` finish (currently a no-op, but Phase 5
 * daemon-mode adds real cleanup like releasing lockfiles).
 */
async function runWithRuntime(
  action: (rt: Runtime) => Promise<CommandResult>,
  /**
   * Optional partial threshold overrides. Bug #52 fix: heavy-generation
   * tasks (plan-drafting, complex synthesis) can take >5 min between
   * tool calls during a single thinking phase — heartbeat hook only fires
   * on PreToolUse/PostToolUse, so the gap is invisible to the reaper.
   * Exposing the existing `thresholdOverrides` seam through the CLI lets
   * the operator pick a timeout that matches the task's thinking budget.
   */
  thresholdOverrides?: Partial<Thresholds>,
): Promise<void> {
  const rt = await createRuntime({
    repoRoot: process.cwd(),
    ...(thresholdOverrides !== undefined ? { thresholdOverrides } : {}),
  });
  try {
    const r = await action(rt);
    if (r.stdout.length > 0) {
      process.stdout.write(r.stdout + '\n');
    }
    process.exitCode = r.exitCode;
  } finally {
    await rt.dispose();
  }
}

/**
 * Pre-commander guard for `manta install`: reject any attempt to re-enable
 * hooks distribution. commander treats `--no-hooks=false` as an "unknown
 * option" (because of its negate-pattern parsing) and exits with the generic
 * error before our install action handler runs, so the rejection has to
 * happen before `program.parseAsync` sees the argv. The same guard catches
 * `--hooks` and any other `--no-hooks=<truthy>` form for the same reason.
 */
function rejectHookOverrideEarly(argv: string[]): boolean {
  const idx = argv.indexOf('install');
  if (idx < 0) return false;
  for (let i = idx + 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--hooks' || a === '--no-hooks=false' || a === '--no-hooks=0') {
      return true;
    }
    if (
      a !== undefined &&
      a.startsWith('--no-hooks=') &&
      a !== '--no-hooks=true' &&
      a !== '--no-hooks=1'
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Pre-commander guard for `manta share --publish` (Phase 7b §0 trust model):
 * a trigger-fired cast may BUILD a bundle (`--non-interactive`) but MUST NOT
 * publish it — publishing always requires interactive human confirmation. So
 * `--publish` together with `--non-interactive` is structurally rejected before
 * commander parses, the same enforcement shape as `install --no-hooks`. A
 * trigger literally cannot construct a publishing invocation. `runShareCommand`
 * also refuses the same combination (defense-in-depth); this is the CLI layer.
 */
function rejectPublishNonInteractiveEarly(argv: string[]): boolean {
  const idx = argv.indexOf('share');
  if (idx < 0) return false;
  const rest = argv.slice(idx);
  return rest.includes('--publish') && rest.includes('--non-interactive');
}

/**
 * Pre-commander guard for `manta share <castId> --version` (H1). commander's
 * global `-V/--version` (registered by program.version()) is resolved during
 * parse and short-circuits ANY subcommand: for `share` — a publish-class
 * command — `manta share <cast> --version 1.0.0` prints the CLI version and
 * exits 0 WITHOUT running the share action. That is a silent fake success on a
 * publish command (it ships nothing yet looks like it worked). The B5 fix
 * renamed the package-version flag to `--pkg-version` to dodge the option-name
 * collision, but the global flag still swallows a mistaken `--version`/`-V` on
 * `share`. Reject it before commander parses so the user gets a loud exit-1
 * pointing at `--pkg-version`, never a 0.1.0/exit-0 no-op. The bare
 * `manta --version` (no subcommand) is untouched — only the post-`share` slice
 * is inspected.
 */
function rejectShareVersionFlagEarly(argv: string[]): boolean {
  const idx = argv.indexOf('share');
  if (idx < 0) return false;
  const rest = argv.slice(idx + 1);
  return rest.includes('--version') || rest.includes('-V');
}

async function main(): Promise<void> {
  if (rejectHookOverrideEarly(process.argv)) {
    process.stderr.write(
      '[manta] install: hooks distribution is deferred to Phase 8; --no-hooks cannot be disabled\n',
    );
    process.exitCode = 11;
    return;
  }

  if (rejectPublishNonInteractiveEarly(process.argv)) {
    process.stderr.write(
      '[manta] share: --publish cannot be combined with --non-interactive; ' +
        'publishing always requires interactive human confirmation (Phase 7b trust model)\n',
    );
    process.exitCode = 2;
    return;
  }

  if (rejectShareVersionFlagEarly(process.argv)) {
    process.stderr.write(
      '[manta] share: --version/-V is the global CLI version flag and cannot set the ' +
        'package version (it would silently print the CLI version and exit without ' +
        'building anything); use --pkg-version <semver> instead\n',
    );
    process.exitCode = 1;
    return;
  }

  // Internal per-clone / per-cast usage budget handed to the spawner so every
  // clone snapshot carries a positive resource cap. These are a token-estimate
  // proxy, NOT dollars, and NOT user-tunable — Claude Code is subscription-
  // based; the user-facing controls are --max-parallel-clones / --max-casts-
  // per-hour. Kept as plain constants so the spawner contract (snapshot budget)
  // stays satisfied without resurrecting the removed dollar flags.
  const INTERNAL_PER_CLONE_TOKEN_ESTIMATE = 300_000;
  const INTERNAL_PER_CAST_TOKEN_ESTIMATE = 1_500_000;

  const program = new Command();
  program
    .name('manta')
    .description('Manta — self-cloning Claude Code pattern (Phase 0)')
    .version('0.1.0');

  const reporter = createReporter({ sink: new StderrSink() });

  program
    .command('cast <mode>')
    .description('Spawn N clones of the given mode (Phase 2a: recon-swarm, forking-realities)')
    .option('-n, --clones <n>', 'number of clones (1..5)', '2')
    .option('-t, --task <task>', 'task description', 'unspecified')
    // Bug #60 class: timing/usage flags gate safety behaviour, so a NaN from a
    // bare parseInt silently disarms the guard. Validate at the CLI boundary
    // with strict coercers. Defaults are numbers (not strings) because
    // commander only runs the coercer on USER-supplied values, never the
    // default — so the default must already be the post-coercion type.
    .option('--cycle-interval-ms <ms>', 'orchestrator cycle interval', parsePositiveIntOption, 5000)
    .option('--tick-budget-ms <ms>', 'overall budget before abort', parsePositiveIntOption, 1_500_000)
    // Usage-aware caps (budget repivot). Claude Code is subscription-based, not
    // pay-per-token — the real constraints are PARALLELISM and cast RATE, not a
    // dollar budget. NaN-reject preserved via parsePositiveIntOption (bug #60).
    .option(
      '--max-parallel-clones <n>',
      'max clones a single cast may spawn at once (parallelism cap). Default: from config or 5.',
      parsePositiveIntOption,
    )
    .option(
      '--max-casts-per-hour <n>',
      'max casts allowed to start in a rolling hour (cast-rate cap, protects your subscription usage/rate limit). Default: from config or 6.',
      parsePositiveIntOption,
    )
    .option(
      '--max-tokens-estimate <n>',
      'optional per-cast usage ceiling (token-estimate proxy, NOT dollars). Rejects the cast if its cumulative per-clone estimate exceeds this.',
      parsePositiveIntOption,
    )
    .option(
      '--max-files-changed <n>',
      'per-clone hard cap on file writes (0 = read-only). Bug #6: must be >0 for casts that produce on-disk deliverables (e.g. research markdown).',
      parseNonNegativeIntOption,
      0,
    )
    .option(
      '--allowed-paths <csv>',
      'comma-separated list of paths each clone may read/write within (relative to repo root). Default: "." (whole repo).',
      '.',
    )
    .option(
      '--forbidden-paths <csv>',
      'comma-separated list of paths each clone MUST NOT touch. Default: ".manta/state,secrets/".',
      '.manta/state,secrets/',
    )
    .option(
      '--tasks <path>',
      "path to a YAML/JSON file with per-clone task overlays. Combines with --task: clones present in the file use the file's entry; clones absent fall back to --task. See docs/user/forking-realities.md for the schema.",
    )
    .option('--dry-run', 'Show usage preview without spawning', false)
    .option('--force', 'Force cast even if the daily usage cap would be exceeded', false)
    .option('--charge-check', 'Enable charge system check (use --no-charge-check to skip)', true)
    .option(
      '--heartbeat-timeout-ms <ms>',
      'Override default 300s heartbeat-stale threshold. Use for heavy-generation tasks (plan-drafting, complex synthesis) where >5min thinking gaps between tool calls are normal — the PostToolUse hook can\'t fire during generation. Bug #52.',
      parsePositiveIntOption,
    )
    .option(
      '--startup-grace-ms <ms>',
      'Override default 300s startup grace period (first heartbeat must arrive within this window). Pair with --heartbeat-timeout-ms when the clone needs longer cold-start due to large priming/snapshot.',
      parsePositiveIntOption,
    )
    .option(
      '--parent-session-id <uuid>',
      'Real Claude session uuid whose transcript clones should inherit (RB1/bug #56). When omitted, resolves from MANTA_PARENT_SESSION_ID then CLAUDE_CODE_SESSION_ID; if all are unset, clones boot without transcript inheritance.',
    )
    .option(
      '--force-full-transcript',
      'Fork the parent transcript regardless of size (bypass --distill-threshold-bytes). RB1/bug #56: by default a transcript larger than the threshold is NOT copied (safe-by-default — avoids re-ingesting an 11.7 MB transcript × N clones).',
      false,
    )
    .option(
      '--distill-threshold-bytes <n>',
      'Parent transcripts strictly larger than this (bytes) skip transcript inheritance unless --force-full-transcript is set (RB1/bug #56). Default 2 MB.',
      parsePositiveIntOption,
    )
    .action(
      async (
        mode: string,
        options: {
          clones: string;
          task: string;
          tasks?: string;
          // Coerced to number by parsePositiveIntOption/parseNonNegativeIntOption
          // at the .option() boundary (bug #60 class).
          cycleIntervalMs: number;
          tickBudgetMs: number;
          maxParallelClones?: number;
          maxCastsPerHour?: number;
          maxTokensEstimate?: number;
          maxFilesChanged: number;
          allowedPaths: string;
          forbiddenPaths: string;
          dryRun: boolean;
          force: boolean;
          chargeCheck: boolean;
          heartbeatTimeoutMs?: number;
          startupGraceMs?: number;
          parentSessionId?: string;
          forceFullTranscript: boolean;
          distillThresholdBytes?: number;
        },
      ) => {
        const splitCsv = (s: string): string[] =>
          s
            .split(',')
            .map((p) => p.trim())
            .filter((p) => p.length > 0);
        // --tasks and --task are complementary, not mutually exclusive: per-
        // clone overlay wins, unspecified clones inherit --task. Parse errors
        // surface as CliError(invalid_input) — bubbled by main()'s isCliError
        // branch.
        const cloneAssignments: Record<string, CloneAssignment> | undefined =
          options.tasks != null ? parseTasksFile(options.tasks) : undefined;
        // Bug #52: collect threshold overrides; pass only if any are set
        // (createRuntime accepts Partial<Thresholds> via thresholdOverrides).
        const thresholdOverrides: Partial<Thresholds> = {};
        if (options.heartbeatTimeoutMs !== undefined) thresholdOverrides.heartbeatTimeoutMs = options.heartbeatTimeoutMs;
        if (options.startupGraceMs !== undefined) thresholdOverrides.startupGraceMs = options.startupGraceMs;
        const hasOverrides = Object.keys(thresholdOverrides).length > 0;
        await runWithRuntime(
          (rt) =>
            runCastCommand(rt, {
            // Cast through unknown so commander's stringly-typed mode flows
            // into the runtime's invalid_input branch for unsupported values.
            mode: mode as unknown as Mode,
            task: options.task,
            // --clones stays a raw parseInt: NaN flows into cast.ts's
            // Number.isInteger(cloneCount) guard, which already rejects it with
            // a 1..5 range error (not a money/timing guard, so out of bug #60's
            // scope). The timing/money fields below are pre-coerced numbers.
            cloneCount: parseInt(options.clones, 10),
            cycleIntervalMs: options.cycleIntervalMs,
            tickBudgetMs: options.tickBudgetMs,
            // Internal per-clone/per-cast usage budget (token-estimate proxy)
            // handed to the spawner so each snapshot carries a positive cap.
            // No longer user-tunable — Claude Code is subscription-based; the
            // user-facing controls are --max-parallel-clones / --max-casts-per-hour.
            internalTokenEstimatePerClone: INTERNAL_PER_CLONE_TOKEN_ESTIMATE,
            internalTokenEstimatePerCast: INTERNAL_PER_CAST_TOKEN_ESTIMATE,
            ...(options.maxParallelClones !== undefined ? { maxParallelClones: options.maxParallelClones } : {}),
            ...(options.maxCastsPerHour !== undefined ? { maxCastsPerHour: options.maxCastsPerHour } : {}),
            ...(options.maxTokensEstimate !== undefined ? { maxTokensEstimate: options.maxTokensEstimate } : {}),
            scope: {
              allowedPaths: splitCsv(options.allowedPaths),
              forbiddenPaths: splitCsv(options.forbiddenPaths),
              maxFilesChanged: options.maxFilesChanged,
            },
            // Conditional spread: under exactOptionalPropertyTypes, `undefined`
            // is not assignable to `cloneAssignments?: Record<...>`. Only emit
            // the property when --tasks was supplied.
            ...(cloneAssignments !== undefined ? { cloneAssignments } : {}),
            castId: `cast-${Date.now()}`,
            ...(options.parentSessionId !== undefined ? { parentSessionId: options.parentSessionId } : {}),
            forceFullTranscript: options.forceFullTranscript,
            ...(options.distillThresholdBytes !== undefined ? { distillThresholdBytes: options.distillThresholdBytes } : {}),
            runner: runClaudeCli(),
            reporter,
            dryRun: options.dryRun,
            force: options.force,
            noChargeCheck: !options.chargeCheck,
          }),
          hasOverrides ? thresholdOverrides : undefined,
        );
      },
    );

  program
    .command('status')
    .description('Show active clones, locks, and claims')
    .action(async () => {
      await runWithRuntime((rt) => runStatusCommand(rt, { reporter }));
    });

  program
    .command('kill <cloneId>')
    .description('Mark a clone DEAD and write its post-mortem')
    .option('-r, --reason <reason>', 'death reason', 'manual kill')
    .action(async (cloneId: string, options: { reason: string }) => {
      await runWithRuntime((rt) =>
        runKillCommand(rt, { cloneId, reason: options.reason, reporter }),
      );
    });

  program
    .command('abort')
    .description('Abort all active clones')
    .option('-r, --reason <reason>', 'reason', 'user-abort')
    .action(async (options: { reason: string }) => {
      await runWithRuntime((rt) =>
        runAbortCommand(rt, { reason: options.reason, reporter }),
      );
    });

  program
    .command('recover')
    .description('Run one orchestrator cycle to clean up stale state')
    .action(async () => {
      await runWithRuntime((rt) => runRecoverCommand(rt, { reporter }));
    });

  program
    .command('promote <target>')
    .description('Merge the winning candidate from a forking-realities cast (format: castId/cloneId)')
    .action(async (target: string) => {
      const sep = target.indexOf('/');
      if (sep === -1) {
        process.stderr.write('[manta] promote: expected format castId/cloneId\n');
        process.exitCode = 1;
        return;
      }
      const castId = target.slice(0, sep);
      const cloneId = target.slice(sep + 1);
      await runWithRuntime((rt) =>
        runPromoteCommand(rt, { castId, cloneId, reporter }),
      );
    });

  program
    .command('inspect <cloneId>')
    .description('Deep-dive into a single clone: registry, contract, locks, events')
    .option('--json', 'output as JSON', false)
    .option('--events <n>', 'number of recent events to show', '10')
    .action(async (cloneId: string, options: { json: boolean; events: string }) => {
      await runWithRuntime((rt) =>
        runInspectCommand(rt, {
          cloneId,
          json: options.json,
          eventCount: Math.min(parseInt(options.events, 10) || 10, 100),
          reporter,
        }),
      );
    });

  program
    .command('tail <cloneId> [durationSeconds]')
    .description('Stream events for a clone in real-time')
    .option('--interval <ms>', 'polling interval in milliseconds', '2000')
    .option('--raw', 'output raw JSON per line', false)
    .action(async (cloneId: string, durationSeconds: string | undefined, options: { interval: string; raw: boolean }) => {
      const durationMs = (durationSeconds != null ? parseInt(durationSeconds, 10) : 300) * 1000;
      const intervalMs = parseInt(options.interval, 10) || 2000;
      await runWithRuntime((rt) =>
        runTailCommand(rt, {
          cloneId,
          durationMs: Math.min(Math.max(durationMs, 10_000), 3_600_000),
          intervalMs: Math.min(Math.max(intervalMs, 500), 10_000),
          raw: options.raw,
          reporter,
        }),
      );
    });

  program
    .command('replay <castId>')
    .description('Replay the timeline of a cast showing phased events and clone summaries')
    .option('-f, --format <format>', 'output format: markdown or json', 'markdown')
    .option('-c, --clone <id>', 'filter to a specific clone (repeatable)', (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option('--since <timestamp>', 'only show events after this Unix timestamp (ms)')
    .action(async (castId: string, options: { format: string; clone: string[]; since?: string }) => {
      await runWithRuntime((rt) =>
        runReplayCommand(rt, {
          castId,
          format: options.format === 'json' ? 'json' : 'markdown',
          ...(options.clone.length > 0 ? { cloneIds: options.clone } : {}),
          ...(options.since != null ? { since: parseInt(options.since, 10) } : {}),
          reporter,
        }),
      );
    });

  program
    .command('audit <cloneId>')
    .description('Audit trail for a single clone: events, gaps, and statistics')
    .option('-f, --format <format>', 'output format: markdown or json', 'markdown')
    .option('-t, --type <type>', 'filter by event type or group (repeatable)', (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option('--since <timestamp>', 'only show events after this Unix timestamp (ms)')
    .option('-l, --limit <n>', 'max events to show (most recent)')
    .option('--gaps', 'highlight gap anomalies', false)
    .option('--gap-threshold <seconds>', 'gap anomaly threshold in seconds', '30')
    .action(async (cloneId: string, options: { format: string; type: string[]; since?: string; limit?: string; gaps: boolean; gapThreshold: string }) => {
      await runWithRuntime((rt) =>
        runAuditCommand(rt, {
          cloneId,
          format: options.format === 'json' ? 'json' : 'markdown',
          ...(options.type.length > 0 ? { typeFilter: options.type } : {}),
          ...(options.since != null ? { since: parseInt(options.since, 10) } : {}),
          ...(options.limit != null ? { limit: parseInt(options.limit, 10) } : {}),
          ...(options.gaps ? { gaps: true } : {}),
          ...(options.gaps ? { gapThreshold: parseInt(options.gapThreshold, 10) } : {}),
          reporter,
        }),
      );
    });

  program
    .command('cost [period]')
    .description('Show spend summary. period: "today" (default) or "weekly"')
    .action(async (period: string | undefined) => {
      // M3: normalize the raw token (today/day/daily | week/weekly) and reject
      // anything else with exit 1 — `cost weekly` used to collapse silently to
      // the daily report. Throwing here propagates to main()'s top-level error
      // renderer (clean `[manta]` line, exit 1).
      const p = normalizeCostPeriod(period);
      await runWithRuntime((rt) => runCostCommand(rt, { period: p, reporter }));
    });

  program
    .command('charges')
    .description('Show charge system state — current charges, cooldown, mode availability')
    .action(async () => {
      await runWithRuntime((rt) => runChargesCommand(rt, { reporter }));
    });

  program
    .command('doctor')
    .description('Health-check your Manta environment — node, claude, bus MCP, git, charges')
    .action(async () => {
      // doctor deliberately does NOT use runWithRuntime: it must run when the
      // environment is broken (no git repo, no bus), which createRuntime refuses.
      const r = await runDoctorCommand();
      if (r.stdout.length > 0) {
        process.stdout.write(r.stdout + '\n');
      }
      process.exitCode = r.exitCode;
    });

  program
    .command('refresh')
    .description('Reset cooldown with double-confirm')
    .action(async () => {
      await runWithRuntime((rt) => runRefreshCommand(rt, { reporter }));
    });

  const limitCmd = program
    .command('limit')
    .description('Read/write budget configuration');

  limitCmd
    .command('get [key]')
    .description('Show budget config (all or specific key)')
    .action(async (key?: string) => {
      await runWithRuntime((rt) =>
        runLimitCommand(rt, { subcommand: 'get', ...(key !== undefined ? { key } : {}), reporter }),
      );
    });

  limitCmd
    .command('set <key> <value>')
    .description('Update a budget config value')
    .action(async (key: string, value: string) => {
      await runWithRuntime((rt) =>
        runLimitCommand(rt, { subcommand: 'set', key, value, reporter }),
      );
    });

  const daemonCmd = program
    .command('daemon')
    .description('Manage daemon (persistent) clones');

  daemonCmd
    .command('status')
    .description('Show active daemon clones')
    .action(async () => {
      await runWithRuntime((rt) => runDaemonStatusCommand(rt, { reporter }));
    });

  daemonCmd
    .command('stop')
    .description('Stop all daemon clones')
    .option('-r, --reason <reason>', 'stop reason', 'manual stop')
    .action(async (options: { reason: string }) => {
      await runWithRuntime((rt) => runDaemonStopCommand(rt, { reason: options.reason, reporter }));
    });

  program
    .command('retask <cloneId>')
    .description('Re-task an idle daemon clone with new work')
    .requiredOption('-t, --task <task>', 'new task description')
    .action(async (cloneId: string, options: { task: string }) => {
      await runWithRuntime((rt) =>
        runRetaskCommand(rt, { cloneId, task: options.task, reporter }),
      );
    });

  program
    .command('feedback <cloneId>')
    .description('Send directed feedback to a clone')
    .requiredOption('-m, --message <msg>', 'feedback message')
    .option('-s, --severity <level>', 'info|correction|blocker', 'info')
    .action(async (cloneId: string, options: { message: string; severity: string }) => {
      const severity = (['info', 'correction', 'blocker'] as const).includes(
        options.severity as 'info' | 'correction' | 'blocker',
      )
        ? (options.severity as 'info' | 'correction' | 'blocker')
        : 'info';
      await runWithRuntime((rt) =>
        runFeedbackCommand(rt, { cloneId, message: options.message, severity, reporter }),
      );
    });

  program
    .command('install [spec]')
    .description(
      'Self-bootstrap Manta (register the bus MCP server from the installed package) ' +
        'when run with no <spec>; with <spec>, install a Manta Library package ' +
        '(npm spec, git URL, or local .tgz)',
    )
    .option('--force', 'overwrite an existing same-version install', false)
    .option('--offline', 'refuse network calls; only local-tgz specs allowed', false)
    .option('--integrity <hash>', 'expected sha256-<base64> tarball hash; mismatch aborts with exit 13')
    .option('--json', 'emit a single JSON line on success or failure', false)
    .option('--dry-run', 'run validation but skip commit, lockfile, and index writes', false)
    .option('--no-validate', 'skip validatePackage (warn loudly); reserved for CI replay')
    .option('--no-hooks', 'reserved; hooks distribution deferred to Phase 8 and cannot be re-enabled')
    .action(
      async (
        spec: string | undefined,
        options: {
          force: boolean;
          offline: boolean;
          integrity?: string;
          json: boolean;
          dryRun: boolean;
          // commander stores --no-X as opts.X = false; default true (and hooks
          // is forced true regardless — see explicit rejection below).
          validate: boolean;
          hooks: boolean;
        },
      ) => {
        // Bare `manta install` (no <spec>) self-bootstraps the bus MCP from the
        // INSTALLED package — a different operation from installing a Library
        // package. It must NOT construct a Runtime/registry and must not reach
        // the --integrity/--no-hooks guards below (those are spec-only).
        if (spec === undefined) {
          try {
            const result = await runBootstrap({
              force: options.force,
              dryRun: options.dryRun,
              json: options.json,
            });
            if (options.json) {
              process.stdout.write(JSON.stringify(result) + '\n');
            } else {
              process.stdout.write(formatBootstrapResult(result) + '\n');
            }
            process.exitCode = 0;
          } catch (err) {
            if (isCliError(err)) {
              process.stderr.write(`[manta] install: ${err.kind}: ${err.message}\n`);
              process.exitCode = err.exitCode;
            } else {
              throw err;
            }
          }
          return;
        }

        // --no-hooks=false / --hooks rejection is handled by
        // rejectHookOverrideEarly() before commander parses (commander treats
        // `--no-hooks=false` as an unknown option and would error out first).
        if (
          options.integrity !== undefined &&
          !/^sha256-[A-Za-z0-9+/=]+$/.test(options.integrity)
        ) {
          const msg = `--integrity must be sha256-<base64>; got "${options.integrity}"`;
          if (options.json) {
            process.stdout.write(
              JSON.stringify({
                error: { code: 'install_integrity_format', message: msg },
              }) + '\n',
            );
          } else {
            process.stderr.write(`[manta] install: ${msg}\n`);
          }
          process.exitCode = 11;
          return;
        }

        const rt = await createRuntime({ repoRoot: process.cwd() });
        try {
          const registryClient = createRegistryClient({
            runner: createDefaultNetworkRunner(),
            offline: options.offline,
          });
          const result = await runInstallCommand(
            {
              repoRoot: rt.repoRoot,
              lockfile: rt.lockfile,
              localStore: rt.localStore,
              registryClient,
              mantaCliVersion: getMantaCliVersion(),
            },
            {
              spec,
              force: options.force,
              offline: options.offline,
              ...(options.integrity !== undefined ? { integrity: options.integrity } : {}),
              dryRun: options.dryRun,
              noValidate: options.validate === false,
              noHooks: true,
            },
          );
          if (options.json) {
            const payload = {
              name: result.packageName,
              version: result.version,
              integrity: result.integrity,
              contributedModes: result.contributedModes,
              contributedSkills: result.contributedSkills,
              contributedCommands: result.contributedCommands,
              contributedTemplates: result.contributedTemplates,
              lockfilePath: result.lockfilePath,
              installPath: result.installedPath,
              dryRun: result.dryRun,
            };
            process.stdout.write(JSON.stringify(payload) + '\n');
          } else {
            const header = result.dryRun
              ? `Dry-run: would install ${result.packageName}@${result.version}`
              : `Installed ${result.packageName}@${result.version}`;
            const stdout = [
              header,
              `  path:    ${result.installedPath}`,
              `  lockfile: ${result.lockfilePath}`,
              `  integrity: ${result.integrity}`,
              `  modes:   ${result.contributedModes.length}`,
              `  skills:  ${result.contributedSkills}`,
              `  commands: ${result.contributedCommands}`,
              `  templates: ${result.contributedTemplates}`,
            ].join('\n');
            process.stdout.write(stdout + '\n');
          }
          process.exitCode = 0;
        } catch (err) {
          if (err instanceof InstallError) {
            if (options.json) {
              process.stdout.write(
                JSON.stringify({
                  error: { code: err.code, message: err.message },
                }) + '\n',
              );
            } else {
              process.stderr.write(`[manta] install: ${err.code}: ${err.message}\n`);
            }
            process.exitCode = err.exitCode;
          } else {
            throw err;
          }
        } finally {
          await rt.dispose();
        }
      },
    );

  program
    .command('share <castId>')
    .description('Build a publishable Manta package bundle from a finalised cast')
    .requiredOption('--name <@scope/name>', 'npm package name for the bundle (required)')
    // B5: this flag is `--pkg-version`, NOT `--version`. commander's global
    // `-V/--version` (set via program.version('0.1.0')) intercepts the
    // space-form `--version 1.0.0` on subcommands — it prints 0.1.0 and exits
    // 0, so the share action never runs and a publish silently "succeeds"
    // doing nothing. A subcommand option cannot reuse `--version` without
    // colliding, so it is renamed outright (no alias is possible).
    .requiredOption('--pkg-version <semver>', 'package version for the bundle (required)')
    .option('--clone <id>', 'winning clone to bundle (overrides merge-review)')
    .option('--out <dir>', 'output directory for the .tar.gz', '.')
    .option('--description <text>', 'package description (default: from post-mortem)')
    .option('--author <text>', 'package author')
    .option('--license <SPDX>', 'package license (SPDX id)')
    .option('--manta-version-compat <range>', 'compatible manta version range (default: caret-pin current)')
    .option('--no-edit', 'skip the $EDITOR README pass')
    .option('--accept-warnings', 'proceed despite non-fatal sanitization warnings')
    .option('--non-interactive', 'CI/trigger mode: no $EDITOR, any warning is fatal, no publish')
    .option('--publish', 'publish the bundle to npm behind MVTS-7 gates (interactive only)')
    .option('--max-bytes <n>', 'refuse publish if the tarball exceeds this many bytes (default 5 MB)', parsePositiveIntOption)
    .action(
      async (
        castId: string,
        options: {
          name: string;
          // commander camel-cases `--pkg-version` → `pkgVersion` (B5).
          pkgVersion: string;
          clone?: string;
          out: string;
          description?: string;
          author?: string;
          license?: string;
          mantaVersionCompat?: string;
          edit: boolean;
          acceptWarnings?: boolean;
          nonInteractive?: boolean;
          publish?: boolean;
          maxBytes?: number;
        },
      ) => {
        const rt = await createRuntime({ repoRoot: process.cwd() });
        try {
          const result = await runShareCommand(rt, {
            castId,
            name: options.name,
            version: options.pkgVersion,
            ...(options.clone !== undefined ? { clone: options.clone } : {}),
            outDir: options.out,
            ...(options.description !== undefined ? { description: options.description } : {}),
            ...(options.author !== undefined ? { author: options.author } : {}),
            ...(options.license !== undefined ? { license: options.license } : {}),
            ...(options.mantaVersionCompat !== undefined
              ? { mantaVersionCompat: options.mantaVersionCompat }
              : {}),
            noEdit: !options.edit,
            ...(options.acceptWarnings !== undefined ? { acceptWarnings: options.acceptWarnings } : {}),
            ...(options.nonInteractive !== undefined ? { nonInteractive: options.nonInteractive } : {}),
            ...(options.publish === true ? { publish: true } : {}),
            ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
          });
          const stdout = [
            `Built ${result.packageName}@${result.version}`,
            `  tarball:   ${result.tarballPath}`,
            `  digest:    ${result.directoryDigest}`,
            `  winner:    ${result.winningCloneId}`,
            `  warnings:  ${result.warnings.length}`,
            ...(result.published !== undefined ? [`  published: ${result.published}`] : []),
          ].join('\n');
          process.stdout.write(stdout + '\n');
          process.exitCode = 0;
        } catch (err) {
          if (err instanceof ShareError) {
            process.stderr.write(`[manta] share: ${err.code}: ${err.message}\n`);
            process.exitCode = err.exitCode;
          } else {
            throw err;
          }
        } finally {
          await rt.dispose();
        }
      },
    );

  program
    .command('uninstall <spec>')
    .description('Remove an installed Manta Library package (@scope/name or @scope/name@version)')
    .option('--force', 'override in-use check for clones in IDLE/WAITING_FOR_TASK/WINDING_DOWN', false)
    .option('--json', 'emit a single JSON line on success or failure', false)
    .action(
      async (spec: string, options: { force: boolean; json: boolean }) => {
        const rt = await createRuntime({ repoRoot: process.cwd() });
        try {
          const result = await runUninstallCommand(
            {
              repoRoot: rt.repoRoot,
              lockfile: rt.lockfile,
              localStore: rt.localStore,
              ctx: rt.ctx,
            },
            { spec, force: options.force },
          );
          if (options.json) {
            process.stdout.write(
              JSON.stringify({
                name: result.removedPackageName,
                version: result.removedVersion,
                path: result.removedPath,
              }) + '\n',
            );
          } else {
            const stdout = [
              `Removed ${result.removedPackageName}@${result.removedVersion}`,
              `  path: ${result.removedPath}`,
            ].join('\n');
            process.stdout.write(stdout + '\n');
          }
          process.exitCode = 0;
        } catch (err) {
          if (err instanceof UninstallError) {
            if (options.json) {
              process.stdout.write(
                JSON.stringify({
                  error: { code: err.code, message: err.message },
                }) + '\n',
              );
            } else {
              process.stderr.write(`[manta] uninstall: ${err.code}: ${err.message}\n`);
            }
            process.exitCode = err.exitCode;
          } else {
            throw err;
          }
        } finally {
          await rt.dispose();
        }
      },
    );

  program
    .command('cleanup')
    .description(
      'Remove Manta from this repo: .manta/worktrees/*, manta/cast-* branches, the manta-bus MCP registration, and .manta/state',
    )
    .option('--dry-run', 'show what would be removed without changing anything', false)
    .option('--yes', 'perform the removal (without it, cleanup only previews, like --dry-run)', false)
    .option('--json', 'emit the result as a single JSON line', false)
    .action(async (options: { dryRun: boolean; yes: boolean; json: boolean }) => {
      const repoRoot = path.resolve(process.cwd());
      try {
        await fs.access(path.join(repoRoot, '.git'));
      } catch (cause) {
        throw new CliError(
          `not a git repo root: ${repoRoot} — run \`manta cleanup\` from inside the repo`,
          { kind: 'invalid_input', cause },
        );
      }
      // Confirmation model: destructive removal requires --yes. Without it (and
      // without --dry-run) we preview exactly like --dry-run and tell the user
      // how to proceed — a CLI can't reliably prompt in every context, and a
      // bare `manta cleanup` must never silently nuke worktrees + state.
      const dryRun = options.dryRun || !options.yes;
      const result = await runCleanupCommand({ repoRoot }, { dryRun });
      if (options.json) {
        process.stdout.write(JSON.stringify(result) + '\n');
      } else {
        process.stdout.write(formatCleanupResult(result) + '\n');
      }
      process.exitCode = 0;
    });

  const libraryCmd = program
    .command('library')
    .description('Inspect installed Manta Library packages (list/show/outdated/doctor)');

  function buildLibraryRuntime(
    rt: Awaited<ReturnType<typeof createRuntime>>,
  ): {
    repoRoot: string;
    lockfile: typeof rt.lockfile;
    localStore: typeof rt.localStore;
    network: ReturnType<typeof createDefaultLibraryNetworkRunner>;
    mantaCliVersion: string;
  } {
    return {
      repoRoot: rt.repoRoot,
      lockfile: rt.lockfile,
      localStore: rt.localStore,
      network: createDefaultLibraryNetworkRunner(),
      mantaCliVersion: getMantaCliVersion(),
    };
  }

  function renderListTable(installs: LibraryListItem[]): string {
    if (installs.length === 0) return 'No library packages installed.';
    const rows = installs.map((i) => ({
      Name: i.packageName,
      Version: i.version,
      Modes: String(i.modes.length),
      Skills: String(i.skills.length),
      Cmds: String(i.commands.length),
      Templates: String(i.templates.length),
      Path: i.path,
    }));
    const headers = ['Name', 'Version', 'Modes', 'Skills', 'Cmds', 'Templates', 'Path'] as const;
    const widths = headers.map((h) =>
      Math.max(h.length, ...rows.map((r) => r[h].length)),
    );
    const fmt = (cells: string[]): string =>
      cells.map((c, i) => c.padEnd(widths[i]!, ' ')).join('  ');
    const out = [fmt(headers as unknown as string[])];
    out.push(widths.map((w) => '-'.repeat(w)).join('  '));
    for (const r of rows) {
      out.push(fmt(headers.map((h) => r[h])));
    }
    return out.join('\n');
  }

  function renderOutdatedTable(report: OutdatedReportItem[]): string {
    if (report.length === 0) return 'No library packages installed.';
    const out = report.map((r) => {
      if (r.status === 'pinned') return `${r.packageName}: pinned (resolved=${r.resolved})`;
      if (r.status === 'outdated') {
        return `${r.packageName}: ${r.currentVersion} → ${r.latestSatisfying} available (range ${r.range})`;
      }
      if (r.status === 'up-to-date') return `${r.packageName}: ${r.currentVersion} (up-to-date)`;
      return `${r.packageName}: unknown (${r.reason ?? 'no reason given'})`;
    });
    return out.join('\n');
  }

  libraryCmd
    .command('list')
    .description('List installed Manta Library packages')
    .option('--json', 'emit JSON {installs:[...]} instead of a table', false)
    .action(async (options: { json: boolean }) => {
      const rt = await createRuntime({ repoRoot: process.cwd() });
      try {
        const result = await runLibraryListCommand(buildLibraryRuntime(rt));
        if (options.json) {
          process.stdout.write(JSON.stringify({ installs: result.installs }) + '\n');
        } else {
          process.stdout.write(renderListTable(result.installs) + '\n');
        }
        process.exitCode = result.exitCode;
      } finally {
        await rt.dispose();
      }
    });

  libraryCmd
    .command('show <spec>')
    .description('Show one installed package (manifest + lockfile entry)')
    .option('--json', 'emit JSON instead of pretty-printed text', false)
    .action(async (spec: string, options: { json: boolean }) => {
      const rt = await createRuntime({ repoRoot: process.cwd() });
      try {
        const result = await runLibraryShowCommand(buildLibraryRuntime(rt), { spec });
        if (options.json) {
          process.stdout.write(
            JSON.stringify({ install: result.install, lockEntry: result.lockEntry }) + '\n',
          );
        } else {
          const lines = [
            `${result.install.packageName}@${result.install.version}`,
            `  path:        ${result.install.path}`,
            `  installedAt: ${result.install.installedAt}`,
            `  integrity:   ${result.install.integrity}`,
            `  modes:       ${result.install.modes.join(', ') || '(none)'}`,
            `  skills:      ${result.install.skills.join(', ') || '(none)'}`,
            `  commands:    ${result.install.commands.join(', ') || '(none)'}`,
            `  templates:   ${result.install.templates.join(', ') || '(none)'}`,
          ];
          if (result.lockEntry) {
            lines.push(
              `  resolved:    ${result.lockEntry.resolved}`,
              `  mantaVersionCompat: ${result.lockEntry.mantaVersionCompat}`,
            );
          }
          process.stdout.write(lines.join('\n') + '\n');
        }
        process.exitCode = result.exitCode;
      } catch (err) {
        if (err instanceof LibraryError) {
          if (options.json) {
            process.stdout.write(
              JSON.stringify({ error: { code: err.code, message: err.message } }) + '\n',
            );
          } else {
            process.stderr.write(`[manta] library show: ${err.code}: ${err.message}\n`);
          }
          process.exitCode = err.exitCode;
        } else {
          throw err;
        }
      } finally {
        await rt.dispose();
      }
    });

  libraryCmd
    .command('outdated')
    .description('Report newer published versions for npm-installed packages (git = pinned)')
    .option('--json', 'emit JSON {report:[...]} instead of a table', false)
    .action(async (options: { json: boolean }) => {
      const rt = await createRuntime({ repoRoot: process.cwd() });
      try {
        const result = await runLibraryOutdatedCommand(buildLibraryRuntime(rt));
        if (options.json) {
          process.stdout.write(JSON.stringify({ report: result.report }) + '\n');
        } else {
          process.stdout.write(renderOutdatedTable(result.report) + '\n');
        }
        process.exitCode = result.exitCode;
      } finally {
        await rt.dispose();
      }
    });

  libraryCmd
    .command('doctor')
    .description('Validate every installed library package against the current CLI')
    .option('--json', 'emit JSON {healthy:[...],unhealthy:[...]} instead of text', false)
    .action(async (options: { json: boolean }) => {
      const rt = await createRuntime({ repoRoot: process.cwd() });
      try {
        const result = await runLibraryDoctorCommand(buildLibraryRuntime(rt));
        if (options.json) {
          process.stdout.write(
            JSON.stringify({ healthy: result.healthy, unhealthy: result.unhealthy }) + '\n',
          );
        } else {
          const lines = [
            `Healthy:   ${result.healthy.length}`,
            `Unhealthy: ${result.unhealthy.length}`,
          ];
          for (const u of result.unhealthy) {
            lines.push(`  ${u.packageName}@${u.version}: ${u.issues.join('; ')}`);
          }
          process.stdout.write(lines.join('\n') + '\n');
        }
        process.exitCode = result.exitCode;
      } catch (err) {
        if (err instanceof LibraryError) {
          if (options.json) {
            const details = err.details as {
              healthy?: unknown;
              unhealthy?: unknown;
            };
            process.stdout.write(
              JSON.stringify({
                error: { code: err.code, message: err.message },
                healthy: details.healthy ?? [],
                unhealthy: details.unhealthy ?? [],
              }) + '\n',
            );
          } else {
            process.stderr.write(`[manta] library doctor: ${err.code}: ${err.message}\n`);
            const details = err.details as { unhealthy?: Array<{ packageName: string; version: string; issues: string[] }> };
            if (Array.isArray(details.unhealthy)) {
              for (const u of details.unhealthy) {
                process.stderr.write(`  ${u.packageName}@${u.version}: ${u.issues.join('; ')}\n`);
              }
            }
          }
          process.exitCode = err.exitCode;
        } else {
          throw err;
        }
      } finally {
        await rt.dispose();
      }
    });

  await program.parseAsync(process.argv);
}

// C2b: route every top-level failure through the friendly renderer — clean
// `[manta] <message>` for known CliError kinds, an actionable hint when the
// `claude` binary is missing, and raw Node stack traces ONLY under
// MANTA_DEBUG=1. The render logic lives in error-render.ts so it is
// unit-testable without importing this bin (which runs main() on load).
main().catch((err) => {
  const { lines, exitCode } = renderTopLevelError(err, {
    debug: process.env.MANTA_DEBUG === '1',
  });
  process.stderr.write(lines.join('\n') + '\n');
  process.exitCode = exitCode;
});

// Crash hygiene: surface uncaught rejections rather than silent. The renderer
// gives the same clean output; we keep a leading marker so an async leak is
// distinguishable from a normal failure.
// I-IMP-4 (Chunk-2 review): only override exitCode when it's currently
// 0/falsy. A stray rejection that fires *after* main() already set
// process.exitCode for a successful or typed-failure cast must not clobber
// that — otherwise a green run reports 99. We don't unit-test process-level
// signal handlers (fragile, low value for a one-line guard).
process.on('unhandledRejection', (err) => {
  const { lines } = renderTopLevelError(err, {
    debug: process.env.MANTA_DEBUG === '1',
  });
  process.stderr.write(
    ['[manta] unhandled promise rejection (this is a bug — please report):', ...lines].join('\n') +
      '\n',
  );
  if (!process.exitCode) process.exitCode = 99;
});
