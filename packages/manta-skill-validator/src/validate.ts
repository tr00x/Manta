import {
  REQUIRED_COMMAND_SECTIONS,
  REQUIRED_SKILL_SECTIONS,
  SkillFrontmatterSchema,
  SlashCommandFrontmatterSchema,
} from './schemas.js';
import { parseDocument } from './parse.js';
import type { ValidationIssue } from './errors.js';

export interface ValidationReport {
  path: string;
  ok: boolean;
  issues: ValidationIssue[];
}

function validateAgainst(
  path: string,
  source: string,
  schema: { safeParse: (x: unknown) => { success: boolean; data?: unknown; error?: { issues: { path: (string | number)[]; message: string }[] } } },
  requiredSections: ReadonlyArray<string>,
): ValidationReport {
  const issues: ValidationIssue[] = [];
  const doc = parseDocument(source);
  if (doc.parseError === 'missing_frontmatter') {
    issues.push({ severity: 'error', code: 'missing_frontmatter', message: 'no `---` frontmatter fence at top of document' });
    return { path, ok: false, issues };
  }
  if (doc.parseError === 'parse_error') {
    issues.push({ severity: 'error', code: 'parse_error', message: 'frontmatter is not valid YAML' });
    return { path, ok: false, issues };
  }
  const r = schema.safeParse(doc.frontmatter ?? {});
  if (!r.success) {
    for (const issue of r.error!.issues) {
      const field = issue.path.join('.');
      const v: ValidationIssue = {
        severity: 'error',
        code: field ? 'invalid_field' : 'invalid_frontmatter',
        message: issue.message,
      };
      if (field) v.field = field;
      issues.push(v);
    }
    return { path, ok: false, issues };
  }
  for (const required of requiredSections) {
    if (!doc.headings.includes(required)) {
      issues.push({ severity: 'error', code: 'missing_section', message: `missing required H2 section: "## ${required}"` });
    }
  }
  return { path, ok: issues.length === 0, issues };
}

export function validateSkill(path: string, source: string): ValidationReport {
  return validateAgainst(path, source, SkillFrontmatterSchema, REQUIRED_SKILL_SECTIONS);
}

export function validateCommand(path: string, source: string): ValidationReport {
  return validateAgainst(path, source, SlashCommandFrontmatterSchema, REQUIRED_COMMAND_SECTIONS);
}
