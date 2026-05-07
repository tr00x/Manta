import type { ZodIssue } from 'zod';

export class BusValidationError extends Error {
  readonly issues: readonly ZodIssue[];
  constructor(message: string, issues: readonly ZodIssue[]) {
    super(message);
    this.name = 'BusValidationError';
    this.issues = issues;
  }
}

export class BusStateError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BusStateError';
  }
}

export class BusNotFoundError extends Error {
  readonly kind: string;
  readonly id: string;
  constructor(kind: string, id: string) {
    super(`${kind} not found: ${id}`);
    this.name = 'BusNotFoundError';
    this.kind = kind;
    this.id = id;
  }
}

export class BusConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BusConflictError';
  }
}

export class BusLockedError extends Error {
  readonly path: string;
  readonly ownerCloneId: string;
  constructor(path: string, ownerCloneId: string) {
    super(`path ${path} is currently locked by ${ownerCloneId}`);
    this.name = 'BusLockedError';
    this.path = path;
    this.ownerCloneId = ownerCloneId;
  }
}
