import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTasksFile } from '../../src/spawner/tasks-file.js';

describe('parseTasksFile', () => {
  it('parses a YAML file with two clones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'manta-tf-'));
    try {
      const f = join(dir, 'plan.yaml');
      writeFileSync(
        f,
        `
A:
  task: rewrite SQL
  approach_hint: use index
B:
  task: rewrite SQL
  approach_hint: denormalize
  budget_usd: 4
`,
      );
      const out = parseTasksFile(f);
      expect(out.A!.task).toBe('rewrite SQL');
      expect(out.A!.approach_hint).toBe('use index');
      expect(out.B!.budget_usd).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses a JSON file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'manta-tf-'));
    try {
      const f = join(dir, 'plan.json');
      writeFileSync(
        f,
        JSON.stringify({ A: { task: 'a' }, B: { task: 'b', budget_usd: 2 } }),
      );
      const out = parseTasksFile(f);
      expect(out.A!.task).toBe('a');
      expect(out.B!.budget_usd).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws CliError(invalid_input) on missing file', () => {
    expect(() => parseTasksFile('/nope/nope.yaml')).toThrow(/cannot read file/);
  });

  it('throws CliError(invalid_input) on schema-invalid content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'manta-tf-'));
    try {
      const f = join(dir, 'plan.yaml');
      writeFileSync(f, 'A:\n  task: ""\n'); // empty task — rejected by schema
      expect(() => parseTasksFile(f)).toThrow(/schema mismatch/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws on an unknown extension', () => {
    const dir = mkdtempSync(join(tmpdir(), 'manta-tf-'));
    try {
      const f = join(dir, 'plan.txt');
      writeFileSync(f, 'A:\n  task: x\n');
      expect(() => parseTasksFile(f)).toThrow(/must end in/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws with "<no extension>" marker when the file has no extension at all', () => {
    // path.extname('plan') === '' — the fallback branch in tasks-file.ts:26
    // surfaces "<no extension>" instead of an empty string so the CLI error
    // is grep-able. Without this case, the ternary's right-hand side is
    // never covered.
    const dir = mkdtempSync(join(tmpdir(), 'manta-tf-'));
    try {
      const f = join(dir, 'plan');
      writeFileSync(f, 'A:\n  task: x\n');
      expect(() => parseTasksFile(f)).toThrow(/<no extension>/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an empty assignments object', () => {
    const dir = mkdtempSync(join(tmpdir(), 'manta-tf-'));
    try {
      const f = join(dir, 'plan.json');
      writeFileSync(f, JSON.stringify({}));
      expect(() => parseTasksFile(f)).toThrow(/at least one clone assignment/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects partial scope (all-or-nothing — bus ScopeSchema is .strict())', () => {
    const dir = mkdtempSync(join(tmpdir(), 'manta-tf-'));
    try {
      const f = join(dir, 'plan.yaml');
      writeFileSync(
        f,
        `
A:
  task: x
  scope:
    allowed_paths: [db/]
`,
      );
      // Missing max_files_changed → ScopeSchema rejects (forbidden_paths has
      // a default, but max_files_changed is required and has no default).
      expect(() => parseTasksFile(f)).toThrow(/schema mismatch/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves clone_id case sensitivity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'manta-tf-'));
    try {
      const f = join(dir, 'plan.json');
      writeFileSync(
        f,
        JSON.stringify({ a: { task: 'lower' }, A: { task: 'upper' } }),
      );
      const out = parseTasksFile(f);
      expect(out.a!.task).toBe('lower');
      expect(out.A!.task).toBe('upper');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws CliError(invalid_input) on YAML syntax error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'manta-tf-'));
    try {
      const f = join(dir, 'plan.yaml');
      // Unclosed flow sequence; YAML parser surfaces a syntax error.
      writeFileSync(f, 'A:\n  task: [a, b\n');
      expect(() => parseTasksFile(f)).toThrow(/parse error/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts .yml as an alias for .yaml', () => {
    const dir = mkdtempSync(join(tmpdir(), 'manta-tf-'));
    try {
      const f = join(dir, 'plan.yml');
      writeFileSync(f, 'A:\n  task: short-yml\n');
      const out = parseTasksFile(f);
      expect(out.A!.task).toBe('short-yml');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
