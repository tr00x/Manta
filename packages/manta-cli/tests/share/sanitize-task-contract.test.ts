import { describe, it, expect } from 'vitest';
import { sanitizeTaskContract } from '../../src/share/sanitize-task-contract.js';
import { ShareSanitizationError } from '../../src/share/errors.js';
import type { TaskContract } from '@manta/snapshot';

const ROOT = '/repo';

const contract = (overrides: Partial<TaskContract> = {}): TaskContract => ({
  cloneId: 'B',
  mode: 'forking-realities',
  task: 'Refactor the dispatcher to use a registry.',
  scope: { allowedPaths: ['.'], forbiddenPaths: ['.manta/state'], maxFilesChanged: 30 },
  approachHint: null,
  siblingClones: ['A'],
  deadlineSeconds: 1200,
  sessionMode: 'batch',
  ...overrides,
});

describe('sanitizeTaskContract', () => {
  it('passes a clean contract through unchanged (modulo path relativisation)', () => {
    const { sanitized, warnings } = sanitizeTaskContract(contract(), { repoRoot: ROOT });
    expect(warnings).toEqual([]);
    expect(sanitized.scope.allowedPaths).toEqual(['.']);
    expect(sanitized.task).toBe('Refactor the dispatcher to use a registry.');
    expect(sanitized.approachHint).toBeNull();
  });

  it('throws ShareSanitizationError when the task text contains a secret', () => {
    const c = contract({ task: 'use this key AKIAIOSFODNN7EXAMPLE to deploy' });
    expect(() => sanitizeTaskContract(c, { repoRoot: ROOT })).toThrow(ShareSanitizationError);
    try {
      sanitizeTaskContract(c, { repoRoot: ROOT });
    } catch (e) {
      expect(e).toBeInstanceOf(ShareSanitizationError);
      const err = e as ShareSanitizationError;
      expect(err.code).toBe('secret_in_task_contract');
      expect(err.details.findings.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('throws when approachHint contains a secret', () => {
    const c = contract({ approachHint: 'token: ghp_0123456789abcdef0123456789abcdef0123' });
    expect(() => sanitizeTaskContract(c, { repoRoot: ROOT })).toThrow(ShareSanitizationError);
  });

  it('relativises an absolute in-repo allowedPath to repo root', () => {
    const c = contract({ scope: { allowedPaths: [`${ROOT}/src`], forbiddenPaths: [], maxFilesChanged: 5 } });
    const { sanitized, warnings } = sanitizeTaskContract(c, { repoRoot: ROOT });
    expect(sanitized.scope.allowedPaths).toEqual(['src']);
    expect(warnings).toEqual([]);
  });

  it('drops an out-of-repo allowedPath and emits a warning', () => {
    const c = contract({ scope: { allowedPaths: ['/abs/outside/repo'], forbiddenPaths: [], maxFilesChanged: 5 } });
    const { sanitized, warnings } = sanitizeTaskContract(c, { repoRoot: ROOT });
    expect(sanitized.scope.allowedPaths).toEqual([]);
    expect(warnings.some((w) => w.rule === 'taskContract.scope.allowedPaths')).toBe(true);
  });

  it('relativises/drops forbiddenPaths the same way', () => {
    const c = contract({
      scope: { allowedPaths: ['.'], forbiddenPaths: [`${ROOT}/secrets`, '/abs/elsewhere'], maxFilesChanged: 5 },
    });
    const { sanitized, warnings } = sanitizeTaskContract(c, { repoRoot: ROOT });
    expect(sanitized.scope.forbiddenPaths).toEqual(['secrets']);
    expect(warnings.some((w) => w.rule === 'taskContract.scope.forbiddenPaths')).toBe(true);
  });

  it('keeps non-sensitive fields verbatim', () => {
    const { sanitized } = sanitizeTaskContract(contract(), { repoRoot: ROOT });
    expect(sanitized.cloneId).toBe('B');
    expect(sanitized.mode).toBe('forking-realities');
    expect(sanitized.siblingClones).toEqual(['A']);
    expect(sanitized.deadlineSeconds).toBe(1200);
    expect(sanitized.scope.maxFilesChanged).toBe(30);
  });
});
