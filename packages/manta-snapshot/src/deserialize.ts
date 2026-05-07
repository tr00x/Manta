import { readFile } from 'node:fs/promises';
import { SnapshotSchema, type Snapshot } from './schema';
import {
  SnapshotIOError,
  SnapshotValidationError,
  SnapshotVersionError,
} from './errors';
import { CURRENT_SCHEMA_VERSION, isSupportedVersion, migrate } from './version';

export async function deserializeSnapshot(path: string): Promise<Snapshot> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (cause) {
    throw new SnapshotIOError(`Cannot read snapshot: ${path}`, cause);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new SnapshotIOError(`Snapshot is not valid JSON: ${path}`, cause);
  }

  // Version gate: must be present and a positive integer.
  // - Missing / non-numeric / non-integer  → SnapshotValidationError (malformed input).
  // - <= 0                                  → SnapshotValidationError (malformed input,
  //                                            no version 0 ever existed).
  // - > CURRENT_SCHEMA_VERSION              → SnapshotVersionError (real version drift).
  const versionField = (parsed as { version?: unknown })?.version;
  if (typeof versionField !== 'number' || !Number.isInteger(versionField)) {
    throw new SnapshotValidationError(
      'Snapshot is missing a numeric "version" field',
      [],
    );
  }
  if (versionField <= 0) {
    throw new SnapshotValidationError(
      `Snapshot "version" must be a positive integer (got ${versionField})`,
      [],
    );
  }
  if (!isSupportedVersion(versionField)) {
    throw new SnapshotVersionError(versionField, CURRENT_SCHEMA_VERSION);
  }

  const migrated = migrate(parsed, versionField);

  const result = SnapshotSchema.safeParse(migrated);
  if (!result.success) {
    throw new SnapshotValidationError(
      `Snapshot at ${path} failed schema validation`,
      result.error.issues,
    );
  }
  return result.data;
}
