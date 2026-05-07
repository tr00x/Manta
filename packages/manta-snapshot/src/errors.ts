import type { ZodIssue } from 'zod';

export class SnapshotValidationError extends Error {
  override readonly name = 'SnapshotValidationError';
  readonly issues: ZodIssue[];
  constructor(message: string, issues: ZodIssue[], cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.issues = issues;
  }
}

export class SnapshotIOError extends Error {
  override readonly name = 'SnapshotIOError';
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
  }
}

export class SnapshotVersionError extends Error {
  override readonly name = 'SnapshotVersionError';
  readonly foundVersion: number;
  readonly expectedVersion: number;
  constructor(foundVersion: number, expectedVersion: number) {
    super(
      `Snapshot version mismatch: found v${foundVersion}, expected v${expectedVersion}`,
    );
    this.foundVersion = foundVersion;
    this.expectedVersion = expectedVersion;
  }
}
