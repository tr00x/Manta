import type { Runtime } from '../runtime.js';
import type { Reporter } from '../output/reporter.js';
import type { CommandResult } from './status.js';
import { createInterface } from 'node:readline';

export interface RefreshCommandOptions {
  reporter: Reporter;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
}

async function prompt(
  question: string,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<string> {
  const rl = createInterface({ input, output });
  return new Promise<string>((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function runRefreshCommand(
  rt: Runtime,
  opts: RefreshCommandOptions,
): Promise<CommandResult> {
  const state = await rt.ctx.charges.read();

  if (state.cooldown_until == null || Date.now() >= state.cooldown_until) {
    opts.reporter.info('refresh.no_cooldown');
    return { exitCode: 0, stdout: 'No cooldown active.' };
  }

  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;

  if (!('isTTY' in stdin) || !(stdin as NodeJS.ReadStream).isTTY) {
    return {
      exitCode: 1,
      stdout: 'manta refresh requires interactive confirmation.',
    };
  }

  const expiresAt = new Date(state.cooldown_until).toISOString();
  const warning = [
    '',
    '⚠️  This resets the 24h cooldown.',
    '    Your last cast failed in overdraft.',
    `    Cooldown expires at: ${expiresAt}`,
    '    Charges will be set to 0.',
    '',
  ].join('\n');

  stdout.write(warning + '\n');

  const first = await prompt('Type "refresh" to confirm: ', stdin, stdout);
  if (first !== 'refresh') {
    return { exitCode: 1, stdout: 'Cancelled.' };
  }

  const second = await prompt('Type "refresh" again to double-confirm: ', stdin, stdout);
  if (second !== 'refresh') {
    return { exitCode: 1, stdout: 'Cancelled.' };
  }

  await rt.ctx.charges.clearCooldown();

  opts.reporter.info('refresh.cleared', { previous_cooldown: expiresAt });

  return { exitCode: 0, stdout: 'Cooldown cleared. Charges set to 0.' };
}
