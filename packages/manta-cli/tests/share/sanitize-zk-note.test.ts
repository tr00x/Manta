import { describe, it, expect } from 'vitest';
import { sanitizeZkNote } from '../../src/share/sanitize-zk-note.js';
import { ShareSanitizationError } from '../../src/share/errors.js';

const ROOT = '/Users/x/repo';
const BUNDLED_AT = '2026-05-29T02:13:12Z';

// Mirrors the on-disk shape written by fsMemoryWriters.zkWrite
// (packages/manta-bus/src/memory-writers.ts:92-105).
const note = (over: { body?: string; title?: string; createdAt?: string } = {}): string =>
  [
    '---',
    'id: aB3dEf7h',
    `title: ${over.title ?? 'Forking-realities merge insight'}`,
    'clone_id: B',
    `created_at: ${over.createdAt ?? '1780019289206'}`,
    'tags: ["clone-B", "cast-cast-1780020786877"]',
    '---',
    '',
    `# ${over.title ?? 'Forking-realities merge insight'}`,
    '',
    over.body ?? 'The two clones converged on the same registry approach.',
    '',
  ].join('\n');

describe('sanitizeZkNote', () => {
  it('rewrites created_at (epoch ms) to the bundledAt ISO', () => {
    const { sanitized } = sanitizeZkNote(note(), { repoRoot: ROOT, bundledAt: BUNDLED_AT });
    expect(sanitized).toContain(`created_at: ${BUNDLED_AT}`);
    expect(sanitized).not.toContain('1780019289206');
  });

  it('preserves id, clone_id, title, and tags frontmatter', () => {
    const { sanitized } = sanitizeZkNote(note(), { repoRoot: ROOT, bundledAt: BUNDLED_AT });
    expect(sanitized).toContain('id: aB3dEf7h');
    expect(sanitized).toContain('clone_id: B');
    expect(sanitized).toContain('title: Forking-realities merge insight');
    expect(sanitized).toContain('tags: ["clone-B", "cast-cast-1780020786877"]');
  });

  it('a clean note emits no warnings (only created_at rewritten)', () => {
    const { warnings } = sanitizeZkNote(note(), { repoRoot: ROOT, bundledAt: BUNDLED_AT });
    expect(warnings).toEqual([]);
  });

  it('warns (masked) on an absolute path in the body but leaves the text UNCHANGED', () => {
    const body = 'See /Users/x/secret-project/notes for the prior art.';
    const { sanitized, warnings } = sanitizeZkNote(note({ body }), { repoRoot: ROOT, bundledAt: BUNDLED_AT });
    const pathWarnings = warnings.filter((w) => w.rule === 'zk.body.path');
    expect(pathWarnings.length).toBeGreaterThanOrEqual(1);
    expect(pathWarnings[0]!.maskedMatch).toBeDefined();
    expect(pathWarnings[0]!.maskedMatch).not.toContain('secret-project');
    // No auto-redact: the prose stays verbatim.
    expect(sanitized).toContain('/Users/x/secret-project/notes');
  });

  it('throws fatal when the body contains a secret', () => {
    const body = 'token sk-abcdef0123456789ABCDEF0123 leaked here';
    expect(() => sanitizeZkNote(note({ body }), { repoRoot: ROOT, bundledAt: BUNDLED_AT })).toThrow(
      ShareSanitizationError,
    );
    try {
      sanitizeZkNote(note({ body }), { repoRoot: ROOT, bundledAt: BUNDLED_AT });
    } catch (e) {
      expect((e as ShareSanitizationError).code).toBe('secret_in_zk_note');
    }
  });

  it('throws fatal when the title contains a secret', () => {
    const title = 'key AKIAIOSFODNN7EXAMPLE notes';
    expect(() => sanitizeZkNote(note({ title }), { repoRoot: ROOT, bundledAt: BUNDLED_AT })).toThrow(
      ShareSanitizationError,
    );
  });
});
