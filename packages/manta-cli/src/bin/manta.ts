#!/usr/bin/env node
import { Command } from 'commander';
import { createRuntime, type Runtime } from '../runtime.js';
import { runCastCommand } from '../commands/cast.js';
import { runStatusCommand } from '../commands/status.js';
import { runKillCommand } from '../commands/kill.js';
import { runAbortCommand } from '../commands/abort.js';
import { runRecoverCommand } from '../commands/recover.js';
import { runClaudeCli } from '../spawner/clone-spawner.js';
import { createReporter, StderrSink } from '../output/reporter.js';
import { isCliError } from '../errors.js';
import type { CommandResult } from '../commands/status.js';
import type { Mode } from '@manta/snapshot';

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
    .description('Spawn N clones of the given mode (Phase 0: recon-swarm only)')
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
    .action(
      async (
        mode: string,
        options: {
          clones: string;
          task: string;
          cycleIntervalMs: string;
          tickBudgetMs: string;
          budgetPerCloneUsd: string;
          budgetPerCastUsd: string;
        },
      ) => {
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

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  if (isCliError(err)) {
    process.stderr.write(`[manta] ${err.kind}: ${err.message}\n`);
    process.exitCode = err.exitCode;
    return;
  }
  process.stderr.write(`[manta] unexpected error: ${(err as Error).message ?? err}\n`);
  process.exitCode = 99;
});

// Crash hygiene: surface uncaught rejections as exit 99 rather than silent.
process.on('unhandledRejection', (err) => {
  process.stderr.write(
    `[manta] unhandledRejection: ${(err as Error)?.message ?? err}\n`,
  );
  process.exitCode = 99;
});
