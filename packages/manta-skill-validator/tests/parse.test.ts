import { describe, it, expect } from 'vitest';
import { parseDocument } from '../src/parse.js';

describe('parseDocument', () => {
  it('parses frontmatter and body', () => {
    const doc = parseDocument([
      '---',
      'name: manta-as-clone',
      'description: clone-side rules',
      'audience: clone',
      'version: 0.0.1',
      '---',
      '',
      '## Purpose',
      'I am an illusion.',
    ].join('\n'));
    expect(doc.frontmatter).toMatchObject({ name: 'manta-as-clone', audience: 'clone' });
    expect(doc.body).toContain('## Purpose');
    expect(doc.headings).toContain('Purpose');
  });

  it('returns missing_frontmatter when no fence present', () => {
    const doc = parseDocument('just markdown without frontmatter');
    expect(doc.frontmatter).toBeUndefined();
    expect(doc.parseError).toBe('missing_frontmatter');
  });

  it('captures parse_error for malformed yaml', () => {
    const doc = parseDocument('---\nname: [bad: yaml\n---\nbody\n');
    expect(doc.parseError).toBe('parse_error');
  });

  it('extracts H2 headings only', () => {
    const doc = parseDocument([
      '---',
      'name: x', 'description: dddddddddd', 'audience: clone', 'version: 0.0.1',
      '---',
      '# Title',
      '## One',
      '### Sub',
      '## Two',
    ].join('\n'));
    expect(doc.headings).toEqual(['One', 'Two']);
  });
});
