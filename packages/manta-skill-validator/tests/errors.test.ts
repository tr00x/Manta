import { describe, it, expect } from 'vitest';
import { ValidationError } from '../src/errors.js';

describe('errors', () => {
  it('ValidationError carries file path + issues', () => {
    const err = new ValidationError('skills/x/SKILL.md', [{ severity: 'error', code: 'missing_field', message: 'name required' }]);
    expect(err.name).toBe('ValidationError');
    expect(err.path).toBe('skills/x/SKILL.md');
    expect(err.issues).toHaveLength(1);
    expect(err.issues[0]!.severity).toBe('error');
  });
});
