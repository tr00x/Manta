#!/usr/bin/env node
import { Command } from 'commander';
import { createRuntime, type Runtime } from '../runtime.js';
import { runCastCommand } from '../commands/cast.js';
import { runStatusCommand } from '../commands/status.js';
import { runKillCommand } from '../commands/kill.js';
import { runAbortCommand } from '../commands/abort.js';
import { runRecoverCommand } from '../commands/recover.js';
import { runPromoteCommand } from '../commands/promote.js';
import { runInspectCommand } from '../commands/inspect.js';
import { runTailCommand } from '../commands/tail.js';
import { runClaudeCli } from '../spawner/clone-spawner.js';
import { parseTasksFile } from '../spawner/tasks-file.js';
import { createReporter, StderrSink } from '../output/reporter.js';
import { isCliError } from '../errors.js';
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
): Promise<void> {
  const rt = await createRuntime({ repoRoot: process.cwd() });
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

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('manta')
    .description('Manta — self-cloning Claude Code pattern (Phase 0)')
    .version('0.0.0');

  const reporter = createReporter({ sink: new StderrSink() });

  program
    .command('cast <mode>')
    .description('Spawn N clones of the given mode (Phase 2a: recon-swarm, forking-realities)')
    .option('-n, --clones <n>', 'number of clones (1..5)', '2')
    .option('-t, --task <task>', 'task description', 'unspecified')
    .option('--cycle-interval-ms <ms>', 'orchestrator cycle interval', '5000')
    .option('--tick-budget-ms <ms>', 'overall budget before abort', '1500000')
    .option('--budget-per-clone-usd <amt>', 'dollar budget per clone', '5')
    .option(
      '--budget-per-cast-usd <amt>',
      'cumulative dollar cap for the whole cast',
      '15',
    )
    .option(
      '--max-files-changed <n>',
      'per-clone hard cap on file writes (0 = read-only). Bug #6: must be >0 for casts that produce on-disk deliverables (e.g. research markdown).',
      '0',
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
    .action(
      async (
        mode: string,
        options: {
          clones: string;
          task: string;
          tasks?: string;
          cycleIntervalMs: string;
          tickBudgetMs: string;
          budgetPerCloneUsd: string;
          budgetPerCastUsd: string;
          maxFilesChanged: string;
          allowedPaths: string;
          forbiddenPaths: string;
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
        await runWithRuntime((rt) =>
          runCastCommand(rt, {
            // Cast through unknown so commander's stringly-typed mode flows
            // into the runtime's invalid_input branch for unsupported values.
            mode: mode as unknown as Mode,
            task: options.task,
            cloneCount: parseInt(options.clones, 10),
            cycleIntervalMs: parseInt(options.cycleIntervalMs, 10),
            tickBudgetMs: parseInt(options.tickBudgetMs, 10),
            budgetUsdPerClone: parseFloat(options.budgetPerCloneUsd),
            budgetUsdPerCast: parseFloat(options.budgetPerCastUsd),
            scope: {
              allowedPaths: splitCsv(options.allowedPaths),
              forbiddenPaths: splitCsv(options.forbiddenPaths),
              maxFilesChanged: parseInt(options.maxFilesChanged, 10),
            },
            // Conditional spread: under exactOptionalPropertyTypes, `undefined`
            // is not assignable to `cloneAssignments?: Record<...>`. Only emit
            // the property when --tasks was supplied.
            ...(cloneAssignments !== undefined ? { cloneAssignments } : {}),
            castId: `cast-${Date.now()}`,
            runner: runClaudeCli(),
            reporter,
            // Production: verify manta-bus MCP is registered before spawning
            // (default true; tests pass false explicitly).
          }),
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

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  if (isCliError(err)) {
    process.stderr.write(`[manta] ${err.kind}: ${err.message}\n`);
    if (err.cause) {
      const cause = err.cause as Error;
      process.stderr.write(`[manta] cause: ${cause.message ?? cause}\n`);
      if (cause.stack) process.stderr.write(`${cause.stack}\n`);
    }
    process.exitCode = err.exitCode;
    return;
  }
  process.stderr.write(`[manta] unexpected error: ${(err as Error).message ?? err}\n`);
  if ((err as Error).stack) process.stderr.write(`${(err as Error).stack}\n`);
  process.exitCode = 99;
});

// Crash hygiene: surface uncaught rejections as exit 99 rather than silent.
// I-IMP-4 (Chunk-2 review): only override exitCode when it's currently
// 0/falsy. A stray rejection that fires *after* main() already set
// process.exitCode for a successful or typed-failure cast must not clobber
// that — otherwise a green run reports 99. We don't unit-test process-level
// signal handlers (fragile, low value for a one-line guard).
process.on('unhandledRejection', (err) => {
  process.stderr.write(
    `[manta] unhandledRejection: ${(err as Error)?.message ?? err}\n`,
  );
  if (!process.exitCode) process.exitCode = 99;
});
