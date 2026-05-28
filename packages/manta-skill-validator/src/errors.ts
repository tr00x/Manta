export type Severity = 'error' | 'warning';
export type IssueCode =
  | 'missing_frontmatter'
  | 'invalid_frontmatter'
  | 'missing_field'
  | 'invalid_field'
  | 'missing_section'
  | 'duplicate_name'
  | 'unsafe_path'
  | 'parse_error'
  | 'manifest_missing'
  | 'manifest_parse_error'
  | 'manifest_invalid';

export interface ValidationIssue {
  severity: Severity;
  code: IssueCode;
  message: string;
  field?: string;
}

export class ValidationError extends Error {
  readonly path: string;
  readonly issues: readonly ValidationIssue[];
  constructor(path: string, issues: readonly ValidationIssue[]) {
    super(`validation failed for ${path}: ${issues.length} issue(s)`);
    this.name = 'ValidationError';
    this.path = path;
    this.issues = issues;
  }
}
