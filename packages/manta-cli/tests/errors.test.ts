import { describe, it, expect } from 'vitest';
import { CliError, isCliError } from '../src/errors';

describe('errors', () => {
  it('CliError carries kind + cause + exitCode', () => {
    const inner = new Error('inner');
    const err = new CliError('cast failed', { kind: 'cast_failed', cause: inner, exitCode: 2 });
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe('cast_failed');
    expect(err.cause).toBe(inner);
    expect(err.exitCode).toBe(2);
    expect(err.name).toBe('CliError');
  });

  it('CliError defaults exitCode to 1', () => {
    const err = new CliError('x', { kind: 'invalid_input' });
    expect(err.exitCode).toBe(1);
  });

  it('isCliError narrows correctly', () => {
    expect(isCliError(new CliError('x', { kind: 'invalid_input' }))).toBe(true);
    expect(isCliError(new Error('plain'))).toBe(false);
    expect(isCliError({ name: 'CliError' })).toBe(false);
  });
});
