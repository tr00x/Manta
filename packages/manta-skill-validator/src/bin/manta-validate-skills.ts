#!/usr/bin/env node
import { Command } from 'commander';
import * as path from 'node:path';
import { validateAll } from '../walk.js';

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('manta-validate-skills')
    .description('Validate every skill and slash-command file under a repo root')
    .option('-r, --root <path>', 'repo root', process.cwd())
    .option('--quiet', 'only print errors', false)
    .action(async (options: { root: string; quiet: boolean }) => {
      const root = path.resolve(options.root);
      const result = await validateAll(root);
      let errors = 0;
      for (const r of result.reports) {
        if (r.issues.length === 0) {
          if (!options.quiet) process.stdout.write(`ok    ${r.path}\n`);
          continue;
        }
        errors += r.issues.filter((i) => i.severity === 'error').length;
        process.stdout.write(`FAIL  ${r.path}\n`);
        for (const i of r.issues) {
          process.stdout.write(`      [${i.severity}] ${i.code}${i.field ? ` (${i.field})` : ''}: ${i.message}\n`);
        }
      }
      for (const w of result.warnings) {
        process.stdout.write(`warn  ${w.message}\n`);
      }
      process.stdout.write(`\n${result.reports.length} file(s), ${errors} error(s), ${result.warnings.length} warning(s)\n`);
      process.exitCode = result.allOk ? 0 : 1;
    });
  await program.parseAsync(process.argv);
}

main().catch((err) => {
  process.stderr.write(`[manta-validate-skills] ${(err as Error).message ?? err}\n`);
  process.exitCode = 99;
});
