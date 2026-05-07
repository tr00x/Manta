import matter from 'gray-matter';

export interface ParsedDocument {
  frontmatter?: Record<string, unknown>;
  body: string;
  headings: string[];
  parseError?: 'missing_frontmatter' | 'parse_error';
}

const H2 = /^##\s+(.+?)\s*$/gm;

export function parseDocument(source: string): ParsedDocument {
  const trimmed = source.trimStart();
  if (!trimmed.startsWith('---')) {
    return { body: source, headings: extractHeadings(source), parseError: 'missing_frontmatter' };
  }
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(source);
  } catch {
    return { body: source, headings: [], parseError: 'parse_error' };
  }
  return {
    frontmatter: parsed.data as Record<string, unknown>,
    body: parsed.content,
    headings: extractHeadings(parsed.content),
  };
}

function extractHeadings(body: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  // Module-level /g regex carries state across exec() calls; reset before each scan.
  H2.lastIndex = 0;
  while ((m = H2.exec(body)) !== null) {
    const heading = m[1];
    if (heading !== undefined) out.push(heading.trim());
  }
  return out;
}
