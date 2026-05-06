# Phase 0e — Skills + Slash Commands Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Author the four Phase-0 skill files (`manta-as-clone`, `manta-coordinate`, `manta-graceful-death`, `manta-cast-decide`) and the five Phase-0 slash-command files (`/manta cast`, `/manta status`, `/manta kill`, `/manta abort`, `/manta recover`). Ship a small `@manta/skill-validator` package that lints every skill and command file (frontmatter shape + required content sections) so the CI gate catches drift before Phase 1.

**Architecture:** Skills and slash commands are markdown files at the repo root (`skills/<name>/SKILL.md`, `commands/<name>.md`) — the layout that will become a Claude Code plugin in Phase 7. A small TS package (`@manta/skill-validator`) parses the frontmatter, validates against zod schemas, walks the body for required headings, and exposes both a programmatic API and a `manta-validate-skills` CLI used by `pnpm test` and CI. Skill behavior testing (recorded fixtures per spec Sec 14.1) is structural in Phase 0 — fixtures are deferred to Phase 1 once at least one cast has run end-to-end against a real Claude.

**Tech Stack:** TypeScript 5.x strict, Node 20+, `gray-matter` (frontmatter parser, ~30 KB, well-maintained), `zod`, `commander`, vitest, tsup. No new runtime deps beyond `gray-matter`.

**Non-goals for Phase 0e:**
- The other six skills from spec Sec 8 (`manta-mode-selector`, `manta-merge-review`, `manta-knowledge-harvest`, `manta-conflict-resolve`, `manta-recursion-guard`, `manta-pre-cast-check`) — deferred to Phase 2+ with the modes that require them
- Slash commands beyond the five Phase-0 cast lifecycle ones — see `phase-0d-cli.md` non-goals for the deferral schedule of Sec 12 commands
- Behavioral / recorded-fixture skill tests — Phase 1 (after the first end-to-end recon-swarm cast generates real transcripts)
- Claude Code plugin manifest (`plugin.json`) — Phase 7 distribution
- Hooks (`hooks/`) — Phase 1 (PreToolUse / PostToolUse for capability enforcement requires the bus to be live in production first)

**Quality bar (CLAUDE.md / spec Sec 14):**
- Test coverage ≥ 80 % on `@manta/skill-validator` `src/**/*.ts` (excluding `src/index.ts` and `src/bin/manta-validate-skills.ts`)
- Every skill file passes the validator with zero warnings
- Every slash-command file passes the validator with zero warnings
- TDD per task: failing test → run → minimal impl → re-run → commit
- Atomic, conventional commits
- Validator ships with `README.md` + `ARCHITECTURE.md`

**Reference docs:**
- Source-of-truth design: `docs/superpowers/specs/2026-05-06-manta-pattern-design.md` — Sec 5 (Inter-clone Protocols, anti-gossip), Sec 8 (Skill Suite), Sec 12 (Command Palette), Sec 14 (Production Quality Standards)
- Predecessor plans: `phase-0-foundation.md`, `phase-0b-bus.md`, `phase-0c-orchestrator.md`, `phase-0d-cli.md`
- Project rules: `CLAUDE.md`

---

## Chunks

1. **Chunk 1 — `@manta/skill-validator` package** — package skeleton, frontmatter schema, content-section schema, validator, CLI bin (`manta-validate-skills`), unit tests
2. **Chunk 2 — Skill + slash-command content** — author the 4 skill files and 5 slash-command files, run the validator across them, integration test that walks the repo and asserts every file is valid

---

## Chunk 1: `@manta/skill-validator` package

**Goal of this chunk:** A reusable validator that any future phase can call to gate skill / command authoring. After this chunk, running `pnpm exec manta-validate-skills` from the repo root produces a structured report (zero files yet — that's Chunk 2).

**Files (new):**
- Create: `packages/manta-skill-validator/package.json`
- Create: `packages/manta-skill-validator/tsconfig.json`
- Create: `packages/manta-skill-validator/tsup.config.ts`
- Create: `packages/manta-skill-validator/vitest.config.ts`
- Create: `packages/manta-skill-validator/src/index.ts`
- Create: `packages/manta-skill-validator/src/errors.ts`
- Create: `packages/manta-skill-validator/src/schemas.ts`
- Create: `packages/manta-skill-validator/src/parse.ts`
- Create: `packages/manta-skill-validator/src/validate.ts`
- Create: `packages/manta-skill-validator/src/walk.ts`
- Create: `packages/manta-skill-validator/src/bin/manta-validate-skills.ts`
- Create: `packages/manta-skill-validator/tests/errors.test.ts`
- Create: `packages/manta-skill-validator/tests/schemas.test.ts`
- Create: `packages/manta-skill-validator/tests/parse.test.ts`
- Create: `packages/manta-skill-validator/tests/validate.test.ts`
- Create: `packages/manta-skill-validator/tests/walk.test.ts`
- Modify: root `tsconfig.json` — add `{ "path": "./packages/manta-skill-validator" }` to references

**Why these boundaries:**
- `schemas.ts` owns the *contract* — what a valid skill / command frontmatter must look like. Single source of truth that will be referenced by `phase-0f-recon-swarm-integration.md`'s plugin smoke test.
- `parse.ts` is pure (string → frontmatter+body); easy to unit-test without disk.
- `validate.ts` composes parse + schema + body checks. Returns `ValidationReport` with severity-tagged issues.
- `walk.ts` discovers skill / command files on disk. Disk-touching, kept thin.
- `bin/` is a CLI entrypoint that runs walk + validate and exits non-zero on any error.

### Tasks

- [ ] **1.1: Verify Phase 0d shipped**

Run: `pnpm --filter @manta/cli build && pnpm --filter @manta/cli test`
Expected: both succeed.

- [ ] **1.2: Verify there is no existing `packages/manta-skill-validator/` directory**

Run: `ls packages/manta-skill-validator 2>&1 | head -5`
Expected: `ls: ... No such file or directory`. If it exists: STOP and inspect.

- [ ] **1.3: Create `packages/manta-skill-validator/package.json`**

```json
{
  "name": "@manta/skill-validator",
  "version": "0.0.0",
  "private": true,
  "description": "Manta skill + slash-command frontmatter and content validator",
  "license": "MIT",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "require": "./dist/index.cjs",
      "types": "./dist/index.d.ts"
    }
  },
  "bin": {
    "manta-validate-skills": "./dist/bin/manta-validate-skills.js"
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "lint": "eslint \"src/**/*.ts\" \"tests/**/*.ts\"",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "commander": "^12.0.0",
    "gray-matter": "^4.0.3",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^20.12.0",
    "@vitest/coverage-v8": "^1.6.0",
    "tsup": "^8.0.0",
    "typescript": "^5.4.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **1.4: Create `tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": ".",
    "outDir": "dist",
    "composite": true,
    "tsBuildInfoFile": "dist/.tsbuildinfo"
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

- [ ] **1.5: Create `tsup.config.ts`**

```typescript
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', 'bin/manta-validate-skills': 'src/bin/manta-validate-skills.ts' },
  format: ['esm', 'cjs'],
  dts: { entry: 'src/index.ts' },
  clean: true,
  sourcemap: true,
  target: 'node20',
  splitting: false,
  shims: true,
});
```

- [ ] **1.6: Create `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globals: false,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/bin/**'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
```

- [ ] **1.7: Add to root `tsconfig.json` references**

`Edit` root `tsconfig.json` to append `{ "path": "./packages/manta-skill-validator" }`.

- [ ] **1.8: Install deps**

Run: `pnpm install`
Expected: lockfile updates; `gray-matter` resolves.

- [ ] **1.9: Write failing tests for `errors.ts`**

Create `packages/manta-skill-validator/tests/errors.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { ValidationError } from '../src/errors';

describe('errors', () => {
  it('ValidationError carries file path + issues', () => {
    const err = new ValidationError('skills/x/SKILL.md', [{ severity: 'error', code: 'missing_field', message: 'name required' }]);
    expect(err.name).toBe('ValidationError');
    expect(err.path).toBe('skills/x/SKILL.md');
    expect(err.issues).toHaveLength(1);
    expect(err.issues[0].severity).toBe('error');
  });
});
```

- [ ] **1.10: Run failing errors test**

Run: `pnpm --filter @manta/skill-validator test errors.test.ts`
Expected: FAIL — module missing.

- [ ] **1.11: Implement `errors.ts`**

Create `packages/manta-skill-validator/src/errors.ts`:

```typescript
export type Severity = 'error' | 'warning';
export type IssueCode =
  | 'missing_frontmatter'
  | 'invalid_frontmatter'
  | 'missing_field'
  | 'invalid_field'
  | 'missing_section'
  | 'duplicate_name'
  | 'unsafe_path'
  | 'parse_error';

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
```

- [ ] **1.12: Re-run errors test**

Run: `pnpm --filter @manta/skill-validator test errors.test.ts`
Expected: 1/1 passing.

- [ ] **1.13: Write failing tests for `schemas.ts`**

Create `packages/manta-skill-validator/tests/schemas.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { SkillFrontmatterSchema, SlashCommandFrontmatterSchema, REQUIRED_SKILL_SECTIONS, REQUIRED_COMMAND_SECTIONS } from '../src/schemas';

describe('schemas', () => {
  it('SkillFrontmatterSchema accepts a valid record', () => {
    const r = SkillFrontmatterSchema.safeParse({
      name: 'manta-as-clone',
      description: 'For clones — who I am',
      audience: 'clone',
      version: '0.0.1',
    });
    expect(r.success).toBe(true);
  });

  it('SkillFrontmatterSchema rejects unknown audience', () => {
    expect(SkillFrontmatterSchema.safeParse({
      name: 'x', description: 'd', audience: 'martian', version: '0.0.1',
    }).success).toBe(false);
  });

  it('SkillFrontmatterSchema requires kebab-case name', () => {
    expect(SkillFrontmatterSchema.safeParse({
      name: 'NotKebab', description: 'd', audience: 'clone', version: '0.0.1',
    }).success).toBe(false);
    expect(SkillFrontmatterSchema.safeParse({
      name: 'with spaces', description: 'd', audience: 'clone', version: '0.0.1',
    }).success).toBe(false);
  });

  it('SlashCommandFrontmatterSchema enforces /manta-namespaced names', () => {
    const ok = SlashCommandFrontmatterSchema.safeParse({
      name: 'manta:cast',
      description: 'Cast clones',
      target: 'manta cli',
    });
    expect(ok.success).toBe(true);
    const bad = SlashCommandFrontmatterSchema.safeParse({
      name: 'cast', description: 'd', target: 't',
    });
    expect(bad.success).toBe(false);
  });

  it('REQUIRED_SKILL_SECTIONS lists Purpose / Allowed / Forbidden / Examples', () => {
    expect(REQUIRED_SKILL_SECTIONS).toEqual(['Purpose', 'Allowed', 'Forbidden', 'Examples']);
  });

  it('REQUIRED_COMMAND_SECTIONS lists Usage / Arguments / Behavior', () => {
    expect(REQUIRED_COMMAND_SECTIONS).toEqual(['Usage', 'Arguments', 'Behavior']);
  });
});
```

- [ ] **1.14: Run failing schemas test**

Run: `pnpm --filter @manta/skill-validator test schemas.test.ts`
Expected: FAIL — module missing.

- [ ] **1.15: Implement `schemas.ts`**

Create `packages/manta-skill-validator/src/schemas.ts`:

```typescript
import { z } from 'zod';

export const KEBAB_NAME = /^[a-z][a-z0-9-]*$/;

// `name` is the unique slug used to address a skill (`manta-as-clone`).
// `audience` distinguishes skills meant for the main agent vs. clones vs. shared system rules.
export const SkillFrontmatterSchema = z
  .object({
    name: z.string().min(1).max(64).regex(KEBAB_NAME, 'name must be kebab-case'),
    description: z.string().min(10).max(280),
    audience: z.enum(['main', 'clone', 'system']),
    version: z.string().regex(/^\d+\.\d+\.\d+$/, 'version must be semver MAJOR.MINOR.PATCH'),
    related: z.array(z.string()).default([]),
  })
  .strict();

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

export const COMMAND_NAME = /^manta:[a-z][a-z0-9-]*$/;

export const SlashCommandFrontmatterSchema = z
  .object({
    name: z.string().regex(COMMAND_NAME, 'command name must be `manta:<kebab>`'),
    description: z.string().min(10).max(280),
    target: z.string().min(1),
    aliases: z.array(z.string()).default([]),
  })
  .strict();

export type SlashCommandFrontmatter = z.infer<typeof SlashCommandFrontmatterSchema>;

export const REQUIRED_SKILL_SECTIONS: ReadonlyArray<string> = ['Purpose', 'Allowed', 'Forbidden', 'Examples'];

export const REQUIRED_COMMAND_SECTIONS: ReadonlyArray<string> = ['Usage', 'Arguments', 'Behavior'];
```

- [ ] **1.16: Re-run schemas test**

Run: `pnpm --filter @manta/skill-validator test schemas.test.ts`
Expected: 6/6 passing.

- [ ] **1.17: Write failing tests for `parse.ts`**

Create `packages/manta-skill-validator/tests/parse.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseDocument } from '../src/parse';

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
```

- [ ] **1.18: Run failing parse test**

Run: `pnpm --filter @manta/skill-validator test parse.test.ts`
Expected: FAIL — module missing.

- [ ] **1.19: Implement `parse.ts`**

Create `packages/manta-skill-validator/src/parse.ts`:

```typescript
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
  H2.lastIndex = 0;
  while ((m = H2.exec(body)) !== null) {
    out.push(m[1].trim());
  }
  return out;
}
```

- [ ] **1.20: Re-run parse test**

Run: `pnpm --filter @manta/skill-validator test parse.test.ts`
Expected: 4/4 passing.

- [ ] **1.21: Write failing tests for `validate.ts`**

Create `packages/manta-skill-validator/tests/validate.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { validateSkill, validateCommand } from '../src/validate';

const validSkill = [
  '---',
  'name: manta-as-clone',
  'description: who I am as a clone — what I can and cannot do',
  'audience: clone',
  'version: 0.0.1',
  '---',
  '## Purpose',
  'p',
  '## Allowed',
  'a',
  '## Forbidden',
  'f',
  '## Examples',
  'e',
].join('\n');

const validCommand = [
  '---',
  'name: manta:cast',
  'description: spawn N clones for a given mode',
  'target: manta-cli',
  '---',
  '## Usage',
  'u',
  '## Arguments',
  'a',
  '## Behavior',
  'b',
].join('\n');

describe('validateSkill', () => {
  it('accepts a valid skill', () => {
    const r = validateSkill('skills/manta-as-clone/SKILL.md', validSkill);
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it('reports missing_frontmatter when no fence', () => {
    const r = validateSkill('skills/x/SKILL.md', '## Purpose\nbody');
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'missing_frontmatter')).toBe(true);
  });

  it('reports invalid_frontmatter when zod parse fails', () => {
    const bad = validSkill.replace('audience: clone', 'audience: martian');
    const r = validateSkill('skills/x/SKILL.md', bad);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'invalid_field' && i.field === 'audience')).toBe(true);
  });

  it('reports missing_section when required H2 absent', () => {
    const bad = validSkill.replace('## Forbidden\nf\n', '');
    const r = validateSkill('skills/x/SKILL.md', bad);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'missing_section' && i.message.includes('Forbidden'))).toBe(true);
  });
});

describe('validateCommand', () => {
  it('accepts a valid command', () => {
    const r = validateCommand('commands/cast.md', validCommand);
    expect(r.ok).toBe(true);
  });

  it('rejects non-`manta:` prefix', () => {
    const bad = validCommand.replace('name: manta:cast', 'name: cast');
    const r = validateCommand('commands/cast.md', bad);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.field === 'name')).toBe(true);
  });
});
```

- [ ] **1.22: Run failing validate test**

Run: `pnpm --filter @manta/skill-validator test validate.test.ts`
Expected: FAIL — module missing.

- [ ] **1.23: Implement `validate.ts`**

Create `packages/manta-skill-validator/src/validate.ts`:

```typescript
import {
  REQUIRED_COMMAND_SECTIONS,
  REQUIRED_SKILL_SECTIONS,
  SkillFrontmatterSchema,
  SlashCommandFrontmatterSchema,
} from './schemas';
import { parseDocument } from './parse';
import type { ValidationIssue } from './errors';

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
      issues.push({
        severity: 'error',
        code: field ? 'invalid_field' : 'invalid_frontmatter',
        message: issue.message,
        field: field || undefined,
      });
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
```

- [ ] **1.24: Re-run validate test**

Run: `pnpm --filter @manta/skill-validator test validate.test.ts`
Expected: 6/6 passing.

- [ ] **1.25: Write failing tests for `walk.ts`**

Create `packages/manta-skill-validator/tests/walk.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { walkSkillsAndCommands, validateAll } from '../src/walk';

describe('walkSkillsAndCommands', () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-walk-')); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('returns empty arrays when nothing exists', async () => {
    const r = await walkSkillsAndCommands(root);
    expect(r.skills).toEqual([]);
    expect(r.commands).toEqual([]);
  });

  it('discovers skills/<name>/SKILL.md', async () => {
    await fs.mkdir(path.join(root, 'skills', 'my-skill'), { recursive: true });
    await fs.writeFile(path.join(root, 'skills', 'my-skill', 'SKILL.md'), '# x', 'utf8');
    const r = await walkSkillsAndCommands(root);
    expect(r.skills.map((s) => s.name)).toEqual(['my-skill']);
  });

  it('discovers commands/<name>.md', async () => {
    await fs.mkdir(path.join(root, 'commands'), { recursive: true });
    await fs.writeFile(path.join(root, 'commands', 'cast.md'), '# x', 'utf8');
    const r = await walkSkillsAndCommands(root);
    expect(r.commands.map((c) => c.name)).toEqual(['cast']);
  });

  it('rejects unsafe directory names with unsafe_path issue', async () => {
    await fs.mkdir(path.join(root, 'skills', '..weird'), { recursive: true });
    await fs.writeFile(path.join(root, 'skills', '..weird', 'SKILL.md'), '# x', 'utf8');
    const r = await walkSkillsAndCommands(root);
    expect(r.skills).toEqual([]);
    expect(r.warnings.some((w) => w.code === 'unsafe_path')).toBe(true);
  });
});

describe('validateAll', () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-walk-va-')); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('runs walk + validateSkill/Command and aggregates reports', async () => {
    await fs.mkdir(path.join(root, 'skills', 'good'), { recursive: true });
    await fs.writeFile(path.join(root, 'skills', 'good', 'SKILL.md'), [
      '---', 'name: good', 'description: this is a description ten or more chars', 'audience: clone', 'version: 0.0.1', '---',
      '## Purpose', 'p', '## Allowed', 'a', '## Forbidden', 'f', '## Examples', 'e',
    ].join('\n'), 'utf8');
    await fs.mkdir(path.join(root, 'skills', 'bad'), { recursive: true });
    await fs.writeFile(path.join(root, 'skills', 'bad', 'SKILL.md'), 'no frontmatter here', 'utf8');
    const result = await validateAll(root);
    const okSkills = result.reports.filter((r) => r.ok);
    expect(okSkills).toHaveLength(1);
    expect(result.allOk).toBe(false);
    expect(result.errorCount).toBeGreaterThan(0);
  });
});
```

- [ ] **1.26: Run failing walk test**

Run: `pnpm --filter @manta/skill-validator test walk.test.ts`
Expected: FAIL — module missing.

- [ ] **1.27: Implement `walk.ts`**

Create `packages/manta-skill-validator/src/walk.ts`:

```typescript
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { validateSkill, validateCommand, type ValidationReport } from './validate';
import type { ValidationIssue } from './errors';

const SAFE_DIR = /^[a-z][a-z0-9-]*$/;
const SAFE_FILE = /^[a-z][a-z0-9-]*\.md$/;

export interface DiscoveredFile {
  name: string;
  filePath: string;
}

export interface WalkResult {
  skills: DiscoveredFile[];
  commands: DiscoveredFile[];
  warnings: ValidationIssue[];
}

export async function walkSkillsAndCommands(repoRoot: string): Promise<WalkResult> {
  const warnings: ValidationIssue[] = [];
  const skills = await walkSkills(repoRoot, warnings);
  const commands = await walkCommands(repoRoot, warnings);
  return { skills, commands, warnings };
}

async function walkSkills(repoRoot: string, warnings: ValidationIssue[]): Promise<DiscoveredFile[]> {
  const dir = path.join(repoRoot, 'skills');
  let entries: string[];
  try { entries = await fs.readdir(dir); } catch { return []; }
  const out: DiscoveredFile[] = [];
  for (const e of entries) {
    if (!SAFE_DIR.test(e)) {
      warnings.push({ severity: 'warning', code: 'unsafe_path', message: `skipping unsafe skill directory name: ${e}` });
      continue;
    }
    const file = path.join(dir, e, 'SKILL.md');
    try { await fs.access(file); } catch { continue; }
    out.push({ name: e, filePath: file });
  }
  return out;
}

async function walkCommands(repoRoot: string, warnings: ValidationIssue[]): Promise<DiscoveredFile[]> {
  const dir = path.join(repoRoot, 'commands');
  let entries: string[];
  try { entries = await fs.readdir(dir); } catch { return []; }
  const out: DiscoveredFile[] = [];
  for (const e of entries) {
    if (!SAFE_FILE.test(e)) {
      warnings.push({ severity: 'warning', code: 'unsafe_path', message: `skipping unsafe command file name: ${e}` });
      continue;
    }
    out.push({ name: e.replace(/\.md$/, ''), filePath: path.join(dir, e) });
  }
  return out;
}

export interface ValidateAllResult {
  reports: ValidationReport[];
  warnings: ValidationIssue[];
  allOk: boolean;
  errorCount: number;
}

export async function validateAll(repoRoot: string): Promise<ValidateAllResult> {
  const walked = await walkSkillsAndCommands(repoRoot);
  const reports: ValidationReport[] = [];
  for (const s of walked.skills) {
    const src = await fs.readFile(s.filePath, 'utf8');
    reports.push(validateSkill(path.relative(repoRoot, s.filePath), src));
  }
  for (const c of walked.commands) {
    const src = await fs.readFile(c.filePath, 'utf8');
    reports.push(validateCommand(path.relative(repoRoot, c.filePath), src));
  }
  const errorCount = reports.reduce((acc, r) => acc + r.issues.filter((i) => i.severity === 'error').length, 0);
  return { reports, warnings: walked.warnings, allOk: errorCount === 0, errorCount };
}
```

- [ ] **1.28: Re-run walk test**

Run: `pnpm --filter @manta/skill-validator test walk.test.ts`
Expected: 5/5 passing.

- [ ] **1.29: Implement `bin/manta-validate-skills.ts`**

Create `packages/manta-skill-validator/src/bin/manta-validate-skills.ts`:

```typescript
#!/usr/bin/env node
import { Command } from 'commander';
import * as path from 'node:path';
import { validateAll } from '../walk';

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('manta-validate-skills')
    .description('Validate every skill and slash-command file under a repo root')
    .option('-r, --root <path>', 'repo root', process.cwd())
    .option('--quiet', 'only print errors', false)
    .action(async (options: { root: string; quiet: boolean }) => {
      const root = path.resolve(options.root);
      const result = await validateAll(root);
      let errors = 0;
      for (const r of result.reports) {
        if (r.issues.length === 0) {
          if (!options.quiet) process.stdout.write(`ok    ${r.path}\n`);
          continue;
        }
        errors += r.issues.filter((i) => i.severity === 'error').length;
        process.stdout.write(`FAIL  ${r.path}\n`);
        for (const i of r.issues) {
          process.stdout.write(`      [${i.severity}] ${i.code}${i.field ? ` (${i.field})` : ''}: ${i.message}\n`);
        }
      }
      for (const w of result.warnings) {
        process.stdout.write(`warn  ${w.message}\n`);
      }
      process.stdout.write(`\n${result.reports.length} file(s), ${errors} error(s), ${result.warnings.length} warning(s)\n`);
      process.exitCode = result.allOk ? 0 : 1;
    });
  await program.parseAsync(process.argv);
}

main().catch((err) => {
  process.stderr.write(`[manta-validate-skills] ${(err as Error).message ?? err}\n`);
  process.exitCode = 99;
});
```

- [ ] **1.30: Implement `src/index.ts`**

Create `packages/manta-skill-validator/src/index.ts`:

```typescript
export * from './errors';
export * from './schemas';
export * from './parse';
export * from './validate';
export * from './walk';
```

- [ ] **1.31: Run full Chunk-1 sweep**

Run: `pnpm --filter @manta/skill-validator test:coverage && pnpm --filter @manta/skill-validator lint && pnpm --filter @manta/skill-validator typecheck && pnpm --filter @manta/skill-validator build`
Expected: all green; coverage ≥ 80 %.

- [ ] **1.32: Smoke-run the bin against an empty repo**

Run from repo root:
```
node packages/manta-skill-validator/dist/bin/manta-validate-skills.cjs --root .
```
Expected: prints `0 file(s), 0 error(s), 0 warning(s)` (skills/commands directories don't exist yet); exit code 0.

- [ ] **1.33: Commit Chunk 1**

```bash
git -c user.email="tr00x@proton.me" -c user.name="Tim Hunt" add \
  packages/manta-skill-validator \
  tsconfig.json pnpm-lock.yaml
git -c user.email="tr00x@proton.me" -c user.name="Tim Hunt" commit -m "$(cat <<'EOF'
feat(skill-validator): add @manta/skill-validator with bin

- Frontmatter zod schemas (skill audience: main/clone/system; command name: manta:<kebab>)
- Body section requirements (Purpose/Allowed/Forbidden/Examples for skills;
  Usage/Arguments/Behavior for commands)
- gray-matter parser + validate composer + walk discovery
- bin/manta-validate-skills CLI exits non-zero on any error
- Coverage ≥ 80% on all paths

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Chunk 2: Skill + slash-command content

**Goal of this chunk:** Author the four Phase-0 skill files and five slash-command files. Each must pass the validator from Chunk 1. The integration test runs `validateAll` against `<repoRoot>` and asserts every Phase-0 skill / command is present and clean.

**Files (new):**
- Create: `skills/manta-as-clone/SKILL.md`
- Create: `skills/manta-coordinate/SKILL.md`
- Create: `skills/manta-graceful-death/SKILL.md`
- Create: `skills/manta-cast-decide/SKILL.md`
- Create: `commands/cast.md`
- Create: `commands/status.md`
- Create: `commands/kill.md`
- Create: `commands/abort.md`
- Create: `commands/recover.md`
- Create: `packages/manta-skill-validator/tests/integration.test.ts`
- Create: `packages/manta-skill-validator/README.md`
- Create: `packages/manta-skill-validator/ARCHITECTURE.md`

### Tasks

- [ ] **2.1: Write `skills/manta-as-clone/SKILL.md`**

Use `Write`:

````markdown
---
name: manta-as-clone
description: Identity, scope, and prohibitions when running as a Manta clone (illusion). Loads first thing on clone startup.
audience: clone
version: 0.0.1
related: [manta-coordinate, manta-graceful-death]
---

# manta-as-clone

## Purpose

You are a **clone** — an illusion of the main agent — spawned for one specific scope. The main agent (the caster) is the only voice the user hears; you exist to do work and disappear cleanly. Read your `Snapshot.taskContract` before doing anything else. Acknowledge it via `manta.ack_contract` with a one-sentence interpretation **before** any tool that mutates files.

## Allowed

- **Trust your registry record.** The CLI spawner registered you on the bus before launching this process — you do **not** call `manta.register` yourself. Your `clone_id`, `parent_pid`, `worktree`, and `cast_id` metadata are already populated. (Confirm via `manta.heartbeat` immediately, which fails with `not_found` if anything is wrong.)
- Read any file inside `taskContract.scope.allowed_paths`.
- Edit/Write only inside `taskContract.scope.allowed_paths` and outside `taskContract.scope.forbidden_paths`. Hard cap: `taskContract.scope.max_files_changed` (0 = read-only).
- Heartbeat every ≤ 10 s via `manta.heartbeat`.
- Renew any held file lock every ≤ 5 s via `manta.renew_lock`.
- Broadcast filtered events: `breakthrough`, `blocker`, `dependency`. Send via `manta.broadcast`.
- Direct-message a sibling clone via `manta.message` only for round-table escalation (Sec 5.4).
- Append insights to ZK and PARA via `manta.zk_write` / `manta.para_append` while you're alive.
- On shutdown — even forced — invoke the `manta-graceful-death` skill before exit.

## Forbidden

- **Recursive cast.** Do not invoke any `/manta cast` command unless `phantom-lance` is unlocked (Phase 8). Phase 0 = no recursion. Period.
- **Direct user contact.** You have no terminal. Anything you produce that is not a tool call is invisible to the human. Speak through commits, broadcasts, and the post-mortem.
- **Edits outside the scope.** Phase 1+ ships PreToolUse hooks that block writes to `forbidden_paths` automatically; in Phase 0 the guard is **skill discipline only** — you self-enforce. Do not test it. (Phase 3 fragility-strikes track misbehavior; not yet shipped.)
- **Self-promotion / disagreement chatter.** Spec Sec 5.5 anti-gossip rule: never argue "my version is better." If you disagree with a sibling, escalate to the main via `manta.broadcast` with `event_type: 'blocker'`.
- **Quiet edits to `.manta/state/*`** — that's the bus's business; you read it via MCP, never write directly.
- **Marking yourself DEAD.** Use `manta.suicide_intent` then `manta.report_death`; the orchestrator finalizes the transition.

## Examples

A *good* clone session:

1. Read snapshot → call `manta.task_contract.read` → call `manta.ack_contract` with `"will only read src/routes/*.ts and produce a single markdown file"`.
2. Loop: read files, occasionally call `manta.heartbeat` with progress, lock files you'll cite via `manta.lock`, broadcast a `breakthrough` when you find the routing layer.
3. When done: write your output file inside the scope, `manta.suicide_intent` with `reason: "task complete"`, `manta.report_death` with the path to your last-gasp report, exit 0.

A *bad* clone session — do not do this:

- Write outside `allowed_paths` "just to fix a typo."
- Disagree with sibling-B over Slack-style chatter.
- Cast another `/manta` recursively.
- Skip the ack and start editing immediately.
````

- [ ] **2.2: Validate the new skill**

Run: `node packages/manta-skill-validator/dist/bin/manta-validate-skills.cjs --root .`
Expected: `1 file(s), 0 error(s), 0 warning(s)`; exit code 0.

- [ ] **2.3: Write `skills/manta-coordinate/SKILL.md`**

```markdown
---
name: manta-coordinate
description: File locks, broadcast etiquette, work-claim board. How a clone shares the bus without stepping on siblings.
audience: clone
version: 0.0.1
related: [manta-as-clone]
---

# manta-coordinate

## Purpose

Multiple clones share a single Manta Bus. Coordination is data-driven (locks, claims, broadcasts) — never social. This skill defines exactly which calls to make, when, and what to never do.

## Allowed

- **Lock before write**: any path you intend to edit goes through `manta.lock { clone_id, path }` first. Renew via `manta.renew_lock` every 5 s while held. Release via `manta.unlock` the moment you stop editing.
- **Claim before duplicating**: before doing a piece of work that a sibling could also do (e.g. "summarize subdir X"), call `manta.claim_work { item: "summarize:X", timeout_ms: 600000 }`. If it returns a `conflict`, pick a different item.
- **Filtered broadcast**: only three event types are bus-traffic. Use them sparingly:
  - `breakthrough` — root cause / subproblem solved (sibling may unblock)
  - `blocker` — stuck (main agent intervenes)
  - `dependency` — discovered code that affects another clone's scope
- **Drift report**: every ~50 actions, call `manta.drift_report { score: 0..1, evidence }` so the main agent can spot scope drift early.
- **Anchor sync**: when you receive a `contract_refresh` event from the main, re-read `manta.task_contract.read` and re-ack via `manta.ack_contract`.

## Forbidden

- **Holding a lock without renewing.** Stale leases (15 s without `renew_lock`) are reaped by the orchestrator and emit `lock_reap` events visible in the post-mortem. (Phase 3 will translate these into fragility-strikes; in Phase 0 they're just a quality signal.)
- **Broadcasting status pings** ("started reading routes/index.ts"). Local log only — bus traffic is for actionable events.
- **Direct messages for opinions.** `manta.message` is for round-table escalation (sibling proposes vs sibling proposes). Disagreements → broadcast `blocker` so the main can decide.
- **Bypassing the work-claim board.** Even if you "know" no sibling is doing something, claim it. Future-you (or a re-spawn) reads the claim log to reconstruct lineage.

## Examples

You're cloning a refactor-wave with sibling B and C:

1. Each clone takes a region by claim:
   - You: `manta.claim_work { item: "refactor:auth", timeout_ms: 600000 }` → ok
   - B: claims `refactor:billing`
   - C: claims `refactor:logging`
2. You discover `auth/index.ts` imports `billing/utils.ts` — that's B's scope.
   - You broadcast: `manta.broadcast { event_type: 'dependency', payload: { from: 'auth/index.ts', to: 'billing/utils.ts' } }`.
   - You DO NOT edit billing yourself; you DO NOT message B asking permission.
3. You finish: `manta.release_work { item: "refactor:auth" }`, `manta.unlock` every held path.

Bad pattern:

- "I'll just touch billing/utils.ts since it's a one-liner." → outside scope. Hooks block. Fragility -1.
- "B's plan is wrong, I'll msg them." → anti-gossip violation. Escalate via `blocker` broadcast instead.
```

- [ ] **2.4: Validate**

Run: `node packages/manta-skill-validator/dist/bin/manta-validate-skills.cjs --root .`
Expected: `2 file(s), 0 error(s)`.

- [ ] **2.5: Write `skills/manta-graceful-death/SKILL.md`**

```markdown
---
name: manta-graceful-death
description: How a clone exits cleanly. TTL, kill, drift, completion — every path leaves the bus and worktree clean.
audience: clone
version: 0.0.1
related: [manta-as-clone, manta-coordinate]
---

# manta-graceful-death

## Purpose

Every clone dies. The orchestrator can mark you DEAD without your cooperation, but cleanly handing over saves the post-mortem from being a guess and saves the next clone from having to clean up your mess. Run this skill when any of: TTL approaching (≤ 60 s left), main signaled `/manta kill <you>`, you noticed your own drift > 30 %, or your task is done.

## Allowed

- **Final commit**: `git add ...` your output, then commit with `manta-clone-${cloneId}: <one-line summary>` in the worktree branch. Push not required (the main pulls).
- **Knowledge dump**: 1–3 atomic `manta.zk_write` calls with the most surprising things you learned. Tag each with your `clone_id` and `cast_id`.
- **PARA append**: high-confidence facts get `manta.para_append { category: 'projects', fact }`.
- **Release everything**: `manta.unlock` every held path. `manta.release_work` every claim you still hold.
- **Suicide intent then report**: `manta.suicide_intent { reason }` first (the orchestrator marks WINDING_DOWN), then write your last-gasp report file in the worktree, then `manta.report_death { last_gasp_report_path }`.
- **Exit 0** if normal, **exit 2** if catastrophic.

## Forbidden

- **Silent exits.** Exiting before `report_death` leaves the orchestrator to deduce death from heartbeat staleness — the post-mortem will be thinner. Always announce.
- **Massive ZK dumps.** 1–3 notes, atomic, each with one insight. Spec Sec 5.5 — quality over quantity.
- **Holding locks at exit.** They WILL be reaped, but you'll show up in `lock_reap` events and the main will know you didn't clean up.
- **Pushing to remote.** The main pulls from your worktree branch; you do not push.
- **Editing files outside your worktree on shutdown.** No "one last fix" — your scope ended when the task contract said it ended.

## Examples

TTL-approaching shutdown:

1. Notice TTL is ≤ 60 s.
2. `git add . && git commit -m "manta-clone-A: stopped at 80% — found 12 of ~15 routes"`.
3. `manta.zk_write { title: "auth-routing-pattern", content: "...", tags: ["phase-0", "cast-${castId}"] }`.
4. `manta.unlock` × held paths, `manta.release_work` × held claims.
5. `manta.suicide_intent { reason: "ttl_exhaustion: 80% complete" }`.
6. Write `last-gasp-report.md` to worktree root: 1 paragraph summary + bullet list of pending items.
7. `manta.report_death { last_gasp_report_path: ".manta/worktrees/clone-A/last-gasp-report.md" }`.
8. `process.exit(0)`.

Forced kill (`/manta kill A`):

1. The main has already marked you DEAD via the bus and written a post-mortem.
2. You see the kill signal (orchestrator pings via `contract_refresh`).
3. Skip steps 1–2 above; jump to releasing locks/claims and exiting.
```

- [ ] **2.6: Validate**

Run: `node packages/manta-skill-validator/dist/bin/manta-validate-skills.cjs --root .`
Expected: `3 file(s), 0 error(s)`.

- [ ] **2.7: Write `skills/manta-cast-decide/SKILL.md`**

```markdown
---
name: manta-cast-decide
description: Pre-cast self-check for the main agent. Do I actually need clones? Do I have the budget and cooldown? Which mode?
audience: main
version: 0.0.1
related: []
---

# manta-cast-decide

## Purpose

You're the main agent. The user gave you a task. Before you `/manta cast`, run this skill: every cast costs charges, money, and your own context. Many "feels parallel" tasks are actually serial and a single agent will do them faster + cheaper.

## Allowed

- **Run the four-question gate**:
  1. Does the task read **>5 files in different layers** of the repo? → recon-swarm candidate.
  2. Are there **≥ 2 unobvious architectural alternatives**? → forking-realities (Phase 2+).
  3. Is the task a **same-pattern migration across N places**? → refactor-wave (Phase 2+).
  4. Is it a **multi-layer bug** with unknown root cause? → bug-hunt (Phase 2+).
  - If none match: do it solo. Skip the cast.
- **Cooldown** (50 s between casts per spec Sec 6.1) is **operator discipline** in Phase 0 — there is no automatic gate. Read `/manta status`; if the previous cast hasn't settled (any clone still WORKING), wait. Phase 3 ships enforcement via the charge ledger.
- **Cost gates** in Phase 0 are interim:
  - `--budget-per-clone-usd` (default $5) caps per-clone spend.
  - `--budget-per-cast-usd` (default $15) caps cumulative spend; the CLI rejects `cloneCount × per-clone > per-cast` before spawning.
  - These prevent the dumbest accidents but do **not** track actual spend (no token-counting yet) and do **not** enforce a daily cap. A daily-spend env gate (`MANTA_DAILY_BUDGET_USD`) lands in Phase 1; the full charge ledger lands in Phase 3.
- **Run dry-run** (Phase 1+ feature, deferred).

## Forbidden

- **Casting "to be safe".** A speculative cast is wasted charges. If you can't articulate why parallel beats serial, do it serial.
- **Skipping the four-question gate** because the task "feels big." Big ≠ parallelizable.
- **Recursive cast** from the main's own pre-cast check. The check itself is a solo decision.
- **Casting unsupported modes in Phase 0.** Only `recon-swarm` ships in Phase 0; the CLI rejects others. Don't try.

## Examples

Task: "Document every public API in this codebase."

- Q1: > 5 files? Yes (every file potentially). Q2: alternatives? No, just discovery. Q3: same pattern? Roughly. Q4: bug? No.
- Verdict: **recon-swarm**, 3 clones, each takes a top-level subdir, produces `docs/api-<subdir>.md`.

Task: "Why does the integration test flake on CI but not locally?"

- Q1: probably 5 files. Q2: alternatives? Yes — fix the test, fix the underlying race, mark flaky. **Phase 2+**: forking-realities. **Phase 0**: do it solo and revisit with FR once Phase 2 ships.

Task: "Rename `User.email` to `User.emailAddress` everywhere."

- Q3 hits cleanly: same-pattern migration. **Phase 2+ refactor-wave**. **Phase 0**: solo with `rg`+`sed` + tests.

Task: "Add a feature flag to the auth middleware."

- None of Q1-Q4 hit cleanly. Solo. Skip the cast.
```

- [ ] **2.8: Validate**

Run: `node packages/manta-skill-validator/dist/bin/manta-validate-skills.cjs --root .`
Expected: `4 file(s), 0 error(s)`.

- [ ] **2.9: Write `commands/cast.md`**

```markdown
---
name: manta:cast
description: Spawn N clones for a given mode. Phase 0 supports recon-swarm only.
target: manta-cli
aliases: []
---

# /manta cast

## Usage

```
/manta cast <mode> [--clones N] [--task "task description"]
```

Mode is required. Phase 0: `recon-swarm` only. Other modes throw `invalid_input`.

## Arguments

| Arg | Type | Default | Notes |
|---|---|---|---|
| `<mode>` | string | required | `recon-swarm` (Phase 0) |
| `--clones <n>` | integer 1..5 | 2 | Phase-0 ceiling 5 |
| `--task <desc>` | string | "unspecified" | passed into each clone's task contract |
| `--cycle-interval-ms <ms>` | integer > 0 | 5000 | orchestrator cycle interval |
| `--tick-budget-ms <ms>` | integer > 0 | 1500000 (25 min) | aborts the cast after this |
| `--budget-per-clone-usd <amt>` | number > 0 | 5 | dollarsTotal in each clone's snapshot |
| `--budget-per-cast-usd <amt>` | number > 0 | 15 | cumulative dollar cap; rejects with `invalid_input` if `cloneCount × budget-per-clone-usd > this` |

## Behavior

Delegates to `runCastCommand` (in `@manta/cli`). For each clone:
1. Creates a worktree at `.manta/worktrees/clone-<id>` on branch `manta/<castId>/<id>`.
2. Builds a `Snapshot` via `@manta/snapshot.captureState` and writes it to `.manta/snapshots/<castId>/<id>.snapshot.json`.
3. Writes the `taskContract` to the bus via `manta.task_contract.write`.
4. Spawns the clone process (production: `claude --print --snapshot <path>`; tests: a fake-clone fixture).
5. Runs the orchestrator's tick loop until either every spawned clone is DEAD or `tickBudgetMs` elapses.
6. On exit: returns 0 (success or budget-aborted) with a summary; non-zero on `cast_failed`.

Worktrees stay on disk after the cast for inspection. `manta abort` and Phase-7 `/manta exhume` manage retention.
```

- [ ] **2.10: Write `commands/status.md`**

```markdown
---
name: manta:status
description: Print the orchestrator's snapshot — clones, locks, claims, thresholds.
target: manta-cli
aliases: []
---

# /manta status

## Usage

```
/manta status
```

No arguments.

## Arguments

(none)

## Behavior

Calls `Orchestrator.getStatus()` and renders an ASCII table:

```
Clone | Mode         | State        | Heartbeat age | Locks                | Claims
------+--------------+--------------+---------------+----------------------+----------------------
A     | recon-swarm  | WORKING      | 4s            | src/foo.ts           | task-1
B     | recon-swarm  | WINDING_DOWN | 12s           | -                    | -
```

Exits 0 always. If no clones are registered, prints `No active clones.`
```

- [ ] **2.11: Write `commands/kill.md`**

```markdown
---
name: manta:kill
description: Mark a clone DEAD and write its post-mortem.
target: manta-cli
aliases: []
---

# /manta kill

## Usage

```
/manta kill <cloneId> [--reason "why"]
```

## Arguments

| Arg | Type | Default | Notes |
|---|---|---|---|
| `<cloneId>` | string | required | from `/manta status` |
| `--reason <text>` | string | "manual kill" | recorded in registry + post-mortem |

## Behavior

1. Looks up the clone in the registry. Throws `not_found` (exit 1) if unknown.
2. `Registry.markDead(cloneId, "kill: <reason>")`.
3. Emits a `kill` event on the bus.
4. Calls `runPostMortem` to write `docs/post-mortems/<YYYY-MM-DD>-<castId>-<cloneId>.md`.
5. Returns 0 with a summary line.

The clone's worktree and held locks are NOT touched here — `runRecoverCommand` (or the next orchestrator tick) reaps them.
```

- [ ] **2.12: Write `commands/abort.md`**

```markdown
---
name: manta:abort
description: Mark every live clone DEAD and write a post-mortem each.
target: manta-cli
aliases: []
---

# /manta abort

## Usage

```
/manta abort [--reason "why"]
```

## Arguments

| Arg | Type | Default | Notes |
|---|---|---|---|
| `--reason <text>` | string | "user-abort" | applied to every live clone |

## Behavior

1. Reads every clone in the registry.
2. For each clone whose state ≠ DEAD: `markDead("abort: <reason>")`, emit `abort` event, run `runPostMortem`.
3. Already-DEAD clones are skipped (their `death_reason` is preserved).
4. Returns 0 with `Aborted N clone(s).`

Worktrees persist after abort so the operator can inspect partial state.
```

- [ ] **2.13: Write `commands/recover.md`**

```markdown
---
name: manta:recover
description: Run one orchestrator cycle to detect zombies, reap stale state, and write post-mortems for newly-dead clones.
target: manta-cli
aliases: []
---

# /manta recover

## Usage

```
/manta recover
```

No arguments.

## Arguments

(none)

## Behavior

Calls `Orchestrator.runCycle()` exactly once. Prints a summary:

```
Recovery complete:
  N dead clone(s) detected
  M stale lock(s) reaped
  K expired claim(s) reaped
  P post-mortem(s) written
```

Use after a crash, after a forced kill, or whenever `/manta status` shows clones whose heartbeat age looks suspect. Returns 0 even when nothing was found.
```

- [ ] **2.14: Validate every authored file**

Run: `node packages/manta-skill-validator/dist/bin/manta-validate-skills.cjs --root .`
Expected: `9 file(s), 0 error(s), 0 warning(s)`; exit code 0.

If any file fails: read the error message, fix the offending frontmatter or section heading, re-run.

- [ ] **2.15: Write the integration test**

Create `packages/manta-skill-validator/tests/integration.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAll } from '../src/walk';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('Phase 0e content integration', () => {
  it('every Phase-0 skill and command file passes the validator', async () => {
    const result = await validateAll(repoRoot);
    if (!result.allOk) {
      const detail = result.reports
        .filter((r) => r.issues.length > 0)
        .map((r) => `${r.path}\n  ${r.issues.map((i) => `[${i.severity}] ${i.code}: ${i.message}`).join('\n  ')}`)
        .join('\n');
      throw new Error(`validation failed:\n${detail}`);
    }
    expect(result.errorCount).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  it('all four Phase-0 skills are present', async () => {
    const result = await validateAll(repoRoot);
    const skillReports = result.reports.filter((r) => r.path.startsWith('skills/'));
    const skills = skillReports.map((r) => r.path.replace(/^skills\//, '').replace(/\/SKILL\.md$/, '')).sort();
    expect(skills).toEqual(['manta-as-clone', 'manta-cast-decide', 'manta-coordinate', 'manta-graceful-death']);
  });

  it('all five Phase-0 slash commands are present', async () => {
    const result = await validateAll(repoRoot);
    const commandReports = result.reports.filter((r) => r.path.startsWith('commands/'));
    const commands = commandReports.map((r) => r.path.replace(/^commands\//, '').replace(/\.md$/, '')).sort();
    expect(commands).toEqual(['abort', 'cast', 'kill', 'recover', 'status']);
  });
});
```

- [ ] **2.16: Run integration test**

Run: `pnpm --filter @manta/skill-validator test integration.test.ts`
Expected: 3/3 passing.

- [ ] **2.17: Run final sweep**

Run: `pnpm --filter @manta/skill-validator test:coverage && pnpm --filter @manta/skill-validator lint && pnpm --filter @manta/skill-validator typecheck && pnpm --filter @manta/skill-validator build`
Expected: all green; coverage ≥ 80 %.

- [ ] **2.18: Write `packages/manta-skill-validator/README.md`**

Use `Write`:

````markdown
# @manta/skill-validator

Lints every skill (`skills/<name>/SKILL.md`) and slash-command (`commands/<name>.md`) file in the Manta repo against frontmatter + content schemas.

## Run

```
pnpm exec manta-validate-skills --root .
```

Exit code 0 if every file is valid, non-zero if any error issue exists.

## Schemas

### Skill frontmatter

| Field | Required | Validation |
|---|---|---|
| `name` | yes | kebab-case |
| `description` | yes | 10..280 chars |
| `audience` | yes | `main` / `clone` / `system` |
| `version` | yes | semver MAJOR.MINOR.PATCH |
| `related` | no | array of skill names |

### Skill body

Required H2 sections (in any order): `Purpose`, `Allowed`, `Forbidden`, `Examples`.

### Slash-command frontmatter

| Field | Required | Validation |
|---|---|---|
| `name` | yes | `manta:<kebab>` |
| `description` | yes | 10..280 chars |
| `target` | yes | non-empty |
| `aliases` | no | array of names |

### Slash-command body

Required H2 sections: `Usage`, `Arguments`, `Behavior`.

## Programmatic use

```typescript
import { validateAll } from '@manta/skill-validator';

const result = await validateAll('/path/to/repo');
if (!result.allOk) throw new Error(`${result.errorCount} error(s)`);
```
````

- [ ] **2.19: Write `packages/manta-skill-validator/ARCHITECTURE.md`**

Use `Write`:

````markdown
# @manta/skill-validator — Architecture

## Why this package exists

Skills and slash commands are content, not code. CI cannot run them; the test suite cannot exercise their behavior in Phase 0. The next-best gate is structural validation: every file declares its identity (frontmatter) and provides the same set of sections so a clone or main agent reading them can rely on a fixed shape. This package is that gate.

## Boundaries

- **In scope:** parse frontmatter via gray-matter; validate via zod; check required body sections; walk `skills/` and `commands/` discovering files; CLI bin that exits non-zero on any error.
- **Out of scope:**
  - Behavior validation / recorded fixtures (Phase 1)
  - Plugin manifest / `plugin.json` (Phase 7)
  - Hook validation (`hooks/` directory) — Phase 1

## Module map

| File | Responsibility |
|---|---|
| `errors.ts` | `ValidationError` + `ValidationIssue` shape |
| `schemas.ts` | Zod schemas for skill / command frontmatter; required-section constants |
| `parse.ts` | gray-matter wrapper + H2 heading extractor |
| `validate.ts` | Composes parse + schema + section check; returns `ValidationReport` |
| `walk.ts` | Discovers `skills/<name>/SKILL.md` and `commands/<name>.md`; emits `unsafe_path` warnings for hostile names |
| `bin/manta-validate-skills.ts` | CLI: `--root`, `--quiet`, exits non-zero on error |

## Design choices

- **gray-matter for parsing.** Battle-tested, handles edge cases (Windows line endings, escaped fences). Adding a parser of our own would be re-inventing.
- **Zod for frontmatter contracts.** Same pattern as `@manta/bus` / `@manta/snapshot`. Schemas live with their consumers; downstream tools (Phase 7 plugin manifest generator) can re-import them.
- **No coupling to the Phase-0 file list.** The validator runs against whatever it finds. Adding skills in Phase 1+ requires zero validator changes — only new schema versions if the contract evolves.
- **Walk filters by safe names.** `[a-z][a-z0-9-]*` for directories, `[a-z][a-z0-9-]*\.md` for files. Anything else surfaces as an `unsafe_path` warning, never silently included.

## Test strategy

- **Unit per module** with focused fixtures embedded in tests.
- **Integration test** runs `validateAll(repoRoot)` against the actual Manta repo — proves the four Phase-0 skills and five Phase-0 commands are all present and clean.
- **Smoke** of `bin/manta-validate-skills` against an empty tmp dir to exercise the bin path.
- **Coverage** ≥ 80 %; `bin/**` excluded.
````

- [ ] **2.20: Run final sweep across the whole repo**

Run from repo root:
```
pnpm -r build && pnpm -r test
```
Expected: every package green. The skill-validator integration test confirms all 9 Phase-0 content files validate.

- [ ] **2.21: Commit Chunk 2**

```bash
git -c user.email="tr00x@proton.me" -c user.name="Tim Hunt" add \
  skills commands \
  packages/manta-skill-validator/tests/integration.test.ts \
  packages/manta-skill-validator/README.md \
  packages/manta-skill-validator/ARCHITECTURE.md
git -c user.email="tr00x@proton.me" -c user.name="Tim Hunt" commit -m "$(cat <<'EOF'
feat(skills+commands): Phase-0 skill suite + slash-command files

Skills (4):
- manta-as-clone — clone identity, scope, prohibitions (anti-recursion,
  anti-gossip, no direct user contact)
- manta-coordinate — locks, claims, filtered broadcast, drift reports
- manta-graceful-death — TTL/kill/completion paths (release locks,
  knowledge dump, suicide_intent + report_death, exit code policy)
- manta-cast-decide — main-side pre-cast four-question gate
  (>5 files? alternatives? same-pattern migration? multi-layer bug?)

Slash commands (5) — all delegate to @manta/cli:
- /manta cast / status / kill / abort / recover

Integration test asserts every Phase-0 file is present and validator-clean.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Plan review checkpoint

After Chunk 2 commits:
1. Dispatch plan-document-reviewer with this plan + the design spec.
2. Apply any blocking feedback.
3. INDEX.md status flip is a user action.

## Hand-off

`phase-0f-recon-swarm-integration.md` consumes:
- The skill files as content for clones to load via the Skill tool
- The slash command files as Claude Code's plugin command surface
- `validateAll` from `@manta/skill-validator` as a CI gate before any cast runs (smoke step in the integration test)
