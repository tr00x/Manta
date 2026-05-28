import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { CloneAssignmentSchema, type CloneAssignment } from '@manta/bus';
import { CliError } from '../errors.js';

const FileSchema = z
  .record(CloneAssignmentSchema)
  .refine((rec) => Object.keys(rec).length >= 1, {
    message: 'tasks file must contain at least one clone assignment',
  })
  .refine((rec) => Object.keys(rec).every((k) => k.length >= 1), {
    message: 'tasks file clone_id keys must be non-empty',
  });

/**
 * Parse a `--tasks` file into a `Record<clone_id, CloneAssignment>`. Supports
 * `.yaml` / `.yml` / `.json`. Other extensions raise `invalid_input`. Schema
 * mismatches surface the zod error message verbatim wrapped in `invalid_input`
 * so CLI output stays grep-able. The returned record is validated against
 * `@manta/bus`'s `CloneAssignmentSchema` so each entry is wire-compatible
 * without a second normalisation step downstream.
 */
export function parseTasksFile(file: string): Record<string, CloneAssignment> {
  const ext = path.extname(file).toLowerCase();
  if (!['.yaml', '.yml', '.json'].includes(ext)) {
    throw new CliError(
      `--tasks file must end in .yaml/.yml/.json (got "${ext || '<no extension>'}")`,
      { kind: 'invalid_input' },
    );
  }
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (cause) {
    throw new CliError(`--tasks: cannot read file ${file}`, {
      kind: 'invalid_input',
      cause,
    });
  }
  let parsed: unknown;
  try {
    parsed = ext === '.json' ? JSON.parse(raw) : parseYaml(raw);
  } catch (cause) {
    throw new CliError(`--tasks: parse error in ${file}`, {
      kind: 'invalid_input',
      cause,
    });
  }
  const result = FileSchema.safeParse(parsed);
  if (!result.success) {
    throw new CliError(
      `--tasks: schema mismatch in ${file}: ${result.error.issues
        .map((i) => i.message)
        .join('; ')}`,
      { kind: 'invalid_input', cause: result.error },
    );
  }
  return result.data;
}
