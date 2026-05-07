import { describe, it, expect } from 'vitest';
import { OrchestratorError, isOrchestratorError } from '../src/errors';

describe('errors', () => {
  it('OrchestratorError carries kind + cause', () => {
    const cause = new Error('inner');
    const err = new OrchestratorError('post-mortem failed', { kind: 'post_mortem_failed', cause });
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe('post_mortem_failed');
    expect(err.cause).toBe(cause);
    expect(err.name).toBe('OrchestratorError');
  });

  it('isOrchestratorError narrows correctly', () => {
    const err = new OrchestratorError('x', { kind: 'cycle_failed' });
    expect(isOrchestratorError(err)).toBe(true);
    expect(isOrchestratorError(new Error('plain'))).toBe(false);
    expect(isOrchestratorError({ name: 'OrchestratorError' })).toBe(false);
  });
});
