import { describe, it, expect } from 'vitest';
import type { ZodIssue } from 'zod';
import {
  BusValidationError,
  BusStateError,
  BusNotFoundError,
  BusConflictError,
  BusLockedError,
} from '../src/errors';

describe('errors', () => {
  it('BusValidationError carries zod issues', () => {
    const issue: ZodIssue = { code: 'custom', path: ['x'], message: 'm' };
    const err = new BusValidationError('bad input', [issue]);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('BusValidationError');
    expect(err.issues).toHaveLength(1);
  });

  it('BusStateError carries cause', () => {
    const cause = new Error('disk full');
    const err = new BusStateError('write failed', { cause });
    expect(err.cause).toBe(cause);
    expect(err.name).toBe('BusStateError');
  });

  it('BusNotFoundError carries resource info', () => {
    const err = new BusNotFoundError('clone', 'A');
    expect(err.kind).toBe('clone');
    expect(err.id).toBe('A');
  });

  it('BusConflictError describes the conflict', () => {
    const err = new BusConflictError('contract for A already exists');
    expect(err.name).toBe('BusConflictError');
  });

  it('BusLockedError carries owner clone-id', () => {
    const err = new BusLockedError('foo.ts', 'B');
    expect(err.path).toBe('foo.ts');
    expect(err.ownerCloneId).toBe('B');
  });
});
