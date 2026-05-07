import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SnapshotSchema, type Snapshot } from './schema';
import { SnapshotValidationError, SnapshotIOError } from './errors';

export async function serializeSnapshot(snapshot: Snapshot, destPath: string): Promise<void> {
  const result = SnapshotSchema.safeParse(snapshot);
  if (!result.success) {
    throw new SnapshotValidationError(
      'Snapshot failed validation before serialization',
      result.error.issues,
    );
  }

  const dir = dirname(destPath);
  try {
    await mkdir(dir, { recursive: true });
  } catch (cause) {
    throw new SnapshotIOError(`Cannot create snapshot directory: ${dir}`, cause);
  }

  const payload = JSON.stringify(result.data, null, 2);
  try {
    await writeFile(destPath, payload, { encoding: 'utf-8', flag: 'w' });
  } catch (cause) {
    throw new SnapshotIOError(`Cannot write snapshot to: ${destPath}`, cause);
  }
}
