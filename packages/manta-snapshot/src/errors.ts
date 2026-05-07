import type { ZodIssue } from 'zod';

export class SnapshotValidationError extends Error {
  override readonly name = 'SnapshotValidationError';
  constructor(message: string, public readonly issues: ZodIssue[]) {
    super(message);
  }
}

export class SnapshotIOError extends Error {
  override readonly name = 'SnapshotIOError';
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
  }
}

export class SnapshotVersionError extends Error {
  override readonly name = 'SnapshotVersionError';
  constructor(public readonly foundVersion: number, public readonly expectedVersion: number) {
    super(
      `Snapshot version mismatch: found v${foundVersion}, expected v${expectedVersion}`,
    );
  }
}
