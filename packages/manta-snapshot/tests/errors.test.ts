import { describe, it, expect } from 'vitest';
import {
  SnapshotValidationError,
  SnapshotIOError,
  SnapshotVersionError,
} from '../src/errors';

describe('error classes', () => {
  it('SnapshotValidationError carries zod issues', () => {
    const err = new SnapshotValidationError('bad', [{ code: 'custom', path: ['mode'], message: 'x' }]);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SnapshotValidationError');
    expect(err.issues).toHaveLength(1);
  });

  it('SnapshotValidationError forwards optional cause to Error.cause', () => {
    const cause = new Error('underlying');
    const err = new SnapshotValidationError(
      'bad',
      [{ code: 'custom', path: ['mode'], message: 'x' }],
      cause,
    );
    expect(err.cause).toBe(cause);
    expect(err.name).toBe('SnapshotValidationError');
    expect(err.issues).toHaveLength(1);
  });

  it('SnapshotIOError carries underlying cause', () => {
    const cause = new Error('ENOENT');
    const err = new SnapshotIOError('cannot read', cause);
    expect(err.cause).toBe(cause);
    expect(err.name).toBe('SnapshotIOError');
  });

  it('SnapshotIOError works without a cause', () => {
    const err = new SnapshotIOError('cannot read');
    expect(err.cause).toBeUndefined();
    expect(err.name).toBe('SnapshotIOError');
  });

  it('SnapshotVersionError carries version info', () => {
    const err = new SnapshotVersionError(99, 1);
    expect(err.foundVersion).toBe(99);
    expect(err.expectedVersion).toBe(1);
    expect(err.message).toMatch(/99/);
  });
});
