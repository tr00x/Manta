import { describe, it, expect } from 'vitest';
import { sanitizeWorktreeDiff } from '../../src/share/sanitize-worktree-diff.js';
import { ShareSanitizationError } from '../../src/share/errors.js';

const CLEAN_DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1234567..89abcde 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,4 @@',
  ' export const x = 1;',
  '+export const y = 2;',
].join('\n');

describe('sanitizeWorktreeDiff', () => {
  it('passes a clean diff through unchanged with no warnings', () => {
    const { sanitized, warnings } = sanitizeWorktreeDiff(CLEAN_DIFF);
    expect(sanitized).toBe(CLEAN_DIFF);
    expect(warnings).toEqual([]);
  });

  it('throws ShareSanitizationError when the diff introduces a secret', () => {
    const dirty = CLEAN_DIFF + '\n+const KEY = "AKIAIOSFODNN7EXAMPLE";';
    expect(() => sanitizeWorktreeDiff(dirty)).toThrow(ShareSanitizationError);
    try {
      sanitizeWorktreeDiff(dirty);
    } catch (e) {
      expect((e as ShareSanitizationError).code).toBe('secret_in_worktree_diff');
      expect((e as ShareSanitizationError).details.findings.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('passes an empty diff through unchanged', () => {
    const { sanitized, warnings } = sanitizeWorktreeDiff('');
    expect(sanitized).toBe('');
    expect(warnings).toEqual([]);
  });
});
