# Phase 0 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build production-ready end-to-end `recon-swarm` mode — main agent can `/manta cast recon-swarm` and get **N independent codebase maps** (one per clone, in each clone's worktree + per-clone ZK notes) back from N batch-spawned clones, with full lifecycle management (spawn, heartbeat, dead-clone cleanup, post-mortem). Synthesis / merge is the user's job in Phase 0; an automated `manta-merge-review` step is Phase 2 (`forking-realities`).

**Architecture:** TypeScript pnpm-workspace monorepo with 4 packages (`manta-snapshot`, `manta-bus`, `manta-orchestrator`, `manta-cli`) + skill suite (4 skills) + slash commands (`/manta cast/status/kill/abort/recover`). Manta Bus runs as MCP server (extension over `claude-peers`). Clones are headless `claude --print` processes per worktree. State persisted to `.manta/state/` with versioned JSON; locks heartbeat-based; events flow through orchestrator's append-only event log.

**Tech Stack:** TypeScript 5.x (strict mode), pnpm workspaces, vitest (unit + integration), tsup (bundling), eslint + prettier, Node 20+, MCP SDK (`@modelcontextprotocol/sdk`), zod (runtime validation), execa (subprocess management), chokidar (heartbeat file watcher), commander (CLI parsing).

**Non-goals for Phase 0:**
- Wave-2 modes (`pair-programming`, `test-storm`, `documentation-chase`) — require daemon-mode runtime, deferred to Phase 5
- Aghs-locked modes (`council`, `phantom-lance`, `decoy`) — Phase 8
- Charge system, full budget multi-layer — Phase 3
- `forking-realities` mode — Phase 2 (requires worktree orchestration beyond recon-swarm needs)
- Auto-cast triggers, Manta Library, Templates, Profiles — Phase 7

**Quality bar (per CLAUDE.md / spec Sec 14):**
- Test coverage ≥ 80% on `manta-orchestrator`, `manta-bus`, `manta-cli`, `manta-snapshot`
- No `// TODO: implement` in merged code
- One code path (no `if env === 'prod' else mock`)
- Every feature ships with user-facing docs + architecture note
- Atomic commits, conventional commit messages

**Reference docs:**
- Source-of-truth design: `docs/superpowers/specs/2026-05-06-manta-pattern-design.md`
- Project rules: `CLAUDE.md` (root)
- Bug log: `docs/manta-bugs.md`
- Post-mortems: `docs/post-mortems/`

---

## Chunks

1. **Chunk 1 — Monorepo bootstrap** — pnpm workspace, root configs, lint/test toolchain, CI-ready scripts
2. **Chunk 2 — `manta-snapshot` package** — transcript + state serializer, schema validation, round-trip
3. **Chunk 3 — `manta-bus` package** — MCP server extension over claude-peers, full Manta Bus API (Sec 4 spec)
4. **Chunk 4 — `manta-orchestrator` package** — heartbeat tracking, dead-clone cleanup, post-mortem trigger, event log
5. **Chunk 5 — `manta-cli` package** — `cast`, `status`, `kill`, `abort`, `recover` commands
6. **Chunk 6 — Skill suite + slash commands** — `manta-as-clone`, `manta-coordinate`, `manta-graceful-death`, `manta-cast-decide`; `/manta` slash commands
7. **Chunk 7 — `recon-swarm` end-to-end** — integration test on the Manta repo itself; smoke verification; docs

---

## Chunk 1: Monorepo bootstrap

**Files (new):**
- Create: `package.json` (root, workspace manifest)
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `tsconfig.json` (root references)
- Create: `.eslintrc.cjs`
- Create: `.prettierrc.json`
- Create: `vitest.workspace.ts`
- Create: `.nvmrc`
- Create: `.editorconfig`
- Create: `packages/.gitkeep`
- Create: `scripts/check-node-version.mjs`
- Modify: `.gitignore` — add `*.tsbuildinfo`, `coverage/` already present
- Modify: `package.json` — root scripts (`build`, `test`, `lint`, `typecheck`, `clean`)

**Why these boundaries:**
- Root configs centralize toolchain so each package config is minimal
- `tsconfig.base.json` extended by every package; root `tsconfig.json` uses project references for incremental builds
- vitest workspace mode lets each package have its own config but run in one command
- Node version pinned to avoid environment-driven flakiness

### Tasks

- [ ] **1.1: Verify Node version**

Run: `node --version`
Expected: v20.x or higher.
If lower: install Node 20+ via nvm or system package manager. STOP if cannot upgrade — the runtime depends on Node 20 features (notably stable `fetch` and `node:test` interop guarantees).

- [ ] **1.2: Verify pnpm available**

Run: `pnpm --version`
Expected: 9.x or higher.
If missing: `npm install -g pnpm@latest` or `corepack enable && corepack prepare pnpm@latest --activate`.

- [ ] **1.3: Create `.nvmrc`**

```
20
```

Run: `node --version | head -c 1` — must echo `v` then a number ≥ 20.

- [ ] **1.4: Create `.editorconfig`**

```ini
root = true

[*]
charset = utf-8
end_of_line = lf
indent_style = space
indent_size = 2
insert_final_newline = true
trim_trailing_whitespace = true

[*.md]
trim_trailing_whitespace = false
```

- [ ] **1.5: Create root `package.json`**

```json
{
  "name": "manta-monorepo",
  "version": "0.0.0",
  "private": true,
  "description": "Manta — self-cloning Claude Code pattern (paradigm-shift parallel AI agent)",
  "license": "MIT",
  "engines": {
    "node": ">=20",
    "pnpm": ">=9"
  },
  "packageManager": "pnpm@9.0.0",
  "scripts": {
    "preinstall": "node scripts/check-node-version.mjs",
    "build": "pnpm -r --filter='./packages/*' build",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "lint": "eslint 'packages/**/src/**/*.ts'",
    "lint:fix": "eslint 'packages/**/src/**/*.ts' --fix",
    "format": "prettier --write 'packages/**/*.{ts,json,md}'",
    "typecheck": "tsc -b",
    "clean": "tsc -b --clean && rimraf 'packages/*/dist'"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@typescript-eslint/eslint-plugin": "^7.0.0",
    "@typescript-eslint/parser": "^7.0.0",
    "@vitest/coverage-v8": "^1.5.0",
    "eslint": "^8.57.0",
    "eslint-config-prettier": "^9.1.0",
    "prettier": "^3.2.0",
    "rimraf": "^5.0.0",
    "tsup": "^8.0.0",
    "typescript": "^5.4.0",
    "vitest": "^1.5.0"
  }
}
```

- [ ] **1.6: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - 'packages/*'
```

- [ ] **1.7: Create `scripts/check-node-version.mjs`**

```javascript
import process from 'node:process';

const required = 20;
const major = parseInt(process.versions.node.split('.')[0], 10);

if (major < required) {
  console.error(
    `Manta requires Node >=${required}. Current: ${process.versions.node}. Use nvm or upgrade.`
  );
  process.exit(1);
}
```

- [ ] **1.8: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "noImplicitAny": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "composite": true,
    "incremental": true,
    "isolatedModules": true
  }
}
```

- [ ] **1.9: Create root `tsconfig.json`**

```json
{
  "files": [],
  "references": []
}
```

References will be added per-package in subsequent chunks.

- [ ] **1.10: Create `.eslintrc.cjs`**

Base config has NO `project` setting — type-aware rules are enabled per-package via overrides in each package's own `.eslintrc.cjs` (added in Chunks 2-5). This avoids the chicken-and-egg problem where Chunk 1 lint would fail because no package tsconfig exists yet.

```javascript
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'prettier',
  ],
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/consistent-type-imports': 'error',
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    'no-restricted-syntax': [
      'error',
      {
        selector: "TSAsExpression[typeAnnotation.typeName.name='any']",
        message: 'Avoid `as any`. Use proper types or `unknown` with narrowing.',
      },
    ],
  },
  ignorePatterns: ['dist/', 'node_modules/', '*.cjs', '*.mjs', '*.tsbuildinfo'],
};
```

Type-aware rules (`no-floating-promises`, `no-misused-promises`, `recommended-requiring-type-checking`, `explicit-function-return-type`) are added in each package's own `.eslintrc.cjs` once that package has a `tsconfig.json` (Chunks 2-5).

- [ ] **1.11: Create `.prettierrc.json`**

```json
{
  "semi": true,
  "singleQuote": true,
  "tabWidth": 2,
  "trailingComma": "all",
  "printWidth": 100,
  "arrowParens": "always",
  "endOfLine": "lf"
}
```

- [ ] **1.12: Create `vitest.workspace.ts`**

```typescript
import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'packages/*/vitest.config.ts',
]);
```

(Empty for now; each package adds its own `vitest.config.ts` later.)

- [ ] **1.13: Create `packages/.gitkeep`**

Empty file. Ensures `packages/` directory committed.

- [ ] **1.14: Update `.gitignore` for TypeScript build artifacts**

`.gitignore` already exists from project bootstrap. Append these lines if not present:

```
*.tsbuildinfo
packages/*/dist/
.tsbuild/
pnpm-debug.log*
```

Verify after: `grep -F '*.tsbuildinfo' .gitignore && grep -F 'packages/*/dist/' .gitignore`. Both should match.

- [ ] **1.15: Run `pnpm install`**

Run: `pnpm install`
Expected: succeeds, creates `node_modules/` and `pnpm-lock.yaml` at root. No package errors.
If `preinstall` fails: revisit task 1.1, ensure Node 20+.

- [ ] **1.16: Verify lint is wired (no files to lint yet, must succeed cleanly)**

Run: `pnpm lint; echo "exit=$?"`
Expected: exit code is `0` AND output contains either "No files matching the pattern" or no error lines (only the trailing `exit=0`).
If lint crashes on parser config / plugin resolution: revisit task 1.10 — base config must NOT reference `parserOptions.project` because there are no package tsconfigs yet.

- [ ] **1.17: Verify typecheck wired**

Run: `pnpm typecheck; echo "exit=$?"`
Expected: exit code `0`. No project references resolved yet — that's expected.

- [ ] **1.18: Verify test runner wired**

Run: `pnpm test; echo "exit=$?"`
Expected: exit code `0`. Output mentions "No test files found, exiting with code 0" or similar.

- [ ] **1.18a: Verify build script wired**

Run: `pnpm build; echo "exit=$?"`
Expected: exit code `0`. pnpm reports "No projects matched the filters" — that's correct (no packages yet).

- [ ] **1.19: Commit Chunk 1**

```bash
git -c user.email="tr00x@proton.me" -c user.name="Tim Hunt" add \
  package.json pnpm-workspace.yaml tsconfig.base.json tsconfig.json \
  .eslintrc.cjs .prettierrc.json vitest.workspace.ts \
  .nvmrc .editorconfig packages/.gitkeep scripts/check-node-version.mjs \
  pnpm-lock.yaml .gitignore
git -c user.email="tr00x@proton.me" -c user.name="Tim Hunt" commit -m "$(cat <<'EOF'
chore: bootstrap pnpm monorepo with TypeScript toolchain

- pnpm workspace, Node 20+, strict TS, vitest, eslint, prettier
- Root scripts: build/test/lint/typecheck/clean
- Per-package configs added in subsequent chunks

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Run: `git log --oneline -3` — verify commit landed.

---

## Chunk 2: `manta-snapshot` package

**Goal:** Serialize / deserialize / distill the main agent's state into a versioned JSON snapshot that a headless clone process consumes as initial context.

**Files (new):**
- Create: `packages/manta-snapshot/package.json`
- Create: `packages/manta-snapshot/tsconfig.json`
- Create: `packages/manta-snapshot/tsup.config.ts`
- Create: `packages/manta-snapshot/tsconfig.build.json`
- Create: `packages/manta-snapshot/vitest.config.ts`
- Create: `packages/manta-snapshot/.eslintrc.cjs`
- Create: `packages/manta-snapshot/src/index.ts` (public API)
- Create: `packages/manta-snapshot/src/schema.ts` (zod schemas + types)
- Create: `packages/manta-snapshot/src/capture.ts` (gather state)
- Create: `packages/manta-snapshot/src/serialize.ts` (snapshot → JSON file)
- Create: `packages/manta-snapshot/src/deserialize.ts` (JSON file → snapshot, validated)
- Create: `packages/manta-snapshot/src/distill.ts` (smart context distillation)
- Create: `packages/manta-snapshot/src/version.ts` (schema version constant + migration registry)
- Create: `packages/manta-snapshot/src/errors.ts` (typed error classes)
- Create: `packages/manta-snapshot/tests/schema.test.ts`
- Create: `packages/manta-snapshot/tests/capture.test.ts`
- Create: `packages/manta-snapshot/tests/serialize.test.ts`
- Create: `packages/manta-snapshot/tests/deserialize.test.ts`
- Create: `packages/manta-snapshot/tests/distill.test.ts`
- Create: `packages/manta-snapshot/tests/version.test.ts`
- Create: `packages/manta-snapshot/tests/round-trip.test.ts`
- Create: `packages/manta-snapshot/README.md` (user-facing)
- Create: `packages/manta-snapshot/ARCHITECTURE.md` (internal design note)
- Modify: `tsconfig.json` (root) — add `{ "path": "./packages/manta-snapshot" }` reference

**File responsibilities (single-purpose):**
- `schema.ts` — *only* zod schemas + inferred types. No I/O, no logic.
- `capture.ts` — *only* gathers current state from filesystem / args / stdin. Pure read.
- `serialize.ts` — *only* validates + writes snapshot JSON to disk. No reading.
- `deserialize.ts` — *only* reads + validates + version-migrates a snapshot file.
- `distill.ts` — *only* shrinks a captured state into a transmittable subset (last-N messages, relevant-only files).
- `version.ts` — *only* current schema version + migration table from older versions.
- `errors.ts` — typed errors so callers can catch specific failure modes.
- `index.ts` — re-exports the public surface only.

### Tasks

- [ ] **2.1: Create `packages/manta-snapshot/package.json`**

```json
{
  "name": "@manta/snapshot",
  "version": "0.0.0",
  "private": true,
  "description": "State + transcript serializer for Manta clones",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "lint": "eslint 'src/**/*.ts' 'tests/**/*.ts'",
    "test": "vitest run",
    "test:coverage": "vitest run --coverage",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "tsup": "^8.0.0",
    "typescript": "^5.4.0",
    "vitest": "^1.5.0",
    "@vitest/coverage-v8": "^1.5.0"
  }
}
```

- [ ] **2.2: Create `packages/manta-snapshot/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "tsBuildInfoFile": "./dist/.tsbuildinfo"
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules", "tests"]
}
```

- [ ] **2.3: Create `packages/manta-snapshot/tsup.config.ts`**

```typescript
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
  tsconfig: 'tsconfig.build.json',
  outExtension: ({ format }) => ({
    js: format === 'cjs' ? '.cjs' : '.js',
  }),
});
```

- [ ] **2.3b: Create `packages/manta-snapshot/tsconfig.build.json`**

A build-only tsconfig that disables `composite`/`incremental` so tsup's DTS pipeline doesn't hit TS6307 ("file not in project file list"); the rootDir/include of `tsconfig.json` includes `tests/` to satisfy `tsc --noEmit` from typecheck, which composite mode then rejects for files imported from outside `rootDir`.

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "composite": false,
    "incremental": false,
    "declarationMap": false
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules", "tests"]
}
```

- [ ] **2.4: Create `packages/manta-snapshot/vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
```

- [ ] **2.5: Create `packages/manta-snapshot/.eslintrc.cjs`**

```javascript
module.exports = {
  extends: [
    '../../.eslintrc.cjs',
    'plugin:@typescript-eslint/recommended-requiring-type-checking',
  ],
  parserOptions: {
    project: ['./tsconfig.json'],
    tsconfigRootDir: __dirname,
  },
  rules: {
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': 'error',
    '@typescript-eslint/explicit-function-return-type': [
      'warn',
      { allowExpressions: true },
    ],
  },
};
```

- [ ] **2.6: Add package reference to root `tsconfig.json`**

Edit `tsconfig.json`:

```json
{
  "files": [],
  "references": [
    { "path": "./packages/manta-snapshot" }
  ]
}
```

- [ ] **2.7: Install package dependencies**

Run from repo root: `pnpm install`
Expected: `node_modules` updated, `packages/manta-snapshot/node_modules` populated, `pnpm-lock.yaml` modified.

- [ ] **2.8: Verify package typecheck (still empty src — should fail with "no input files")**

Run: `pnpm --filter @manta/snapshot typecheck`
Expected: error "No inputs were found in config file" — this is the signal we're correctly wired and just lack source files. STOP and recheck Task 2.2 if any other error.

- [ ] **2.9: Write failing test for `version.ts`**

Create `packages/manta-snapshot/tests/version.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { CURRENT_SCHEMA_VERSION, isSupportedVersion, migrate } from '../src/version';

describe('schema version', () => {
  it('exposes current version as a positive integer', () => {
    expect(typeof CURRENT_SCHEMA_VERSION).toBe('number');
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(CURRENT_SCHEMA_VERSION)).toBe(true);
  });

  it('treats current version as supported', () => {
    expect(isSupportedVersion(CURRENT_SCHEMA_VERSION)).toBe(true);
  });

  it('rejects future versions', () => {
    expect(isSupportedVersion(CURRENT_SCHEMA_VERSION + 1)).toBe(false);
  });

  it('rejects non-positive versions', () => {
    expect(isSupportedVersion(0)).toBe(false);
    expect(isSupportedVersion(-1)).toBe(false);
  });

  it('returns input unchanged when migrating from current version', () => {
    const data = { version: CURRENT_SCHEMA_VERSION, payload: 'x' };
    expect(migrate(data, CURRENT_SCHEMA_VERSION)).toBe(data);
  });

  it('throws when migrating from unknown version', () => {
    expect(() => migrate({ version: 99 }, 99)).toThrow(/unsupported/i);
  });
});
```

- [ ] **2.10: Run version test — must fail**

Run: `pnpm --filter @manta/snapshot test version.test.ts`
Expected: FAIL — "Cannot find module '../src/version'".

- [ ] **2.11: Implement `src/version.ts`**

```typescript
export const CURRENT_SCHEMA_VERSION = 1 as const;

type MigrationFn = (data: unknown) => unknown;

const MIGRATIONS: Record<number, MigrationFn> = {
  // No migrations yet — version 1 is the initial schema.
  // Add entries when CURRENT_SCHEMA_VERSION bumps:
  // 1: (data) => migrateV1ToV2(data),
};

export function isSupportedVersion(v: number): boolean {
  return Number.isInteger(v) && v > 0 && v <= CURRENT_SCHEMA_VERSION;
}

export function migrate(data: unknown, fromVersion: number): unknown {
  if (fromVersion === CURRENT_SCHEMA_VERSION) {
    return data;
  }
  if (!isSupportedVersion(fromVersion)) {
    throw new Error(
      `Unsupported snapshot schema version: ${fromVersion} (current: ${CURRENT_SCHEMA_VERSION})`,
    );
  }
  let current = data;
  let v = fromVersion;
  while (v < CURRENT_SCHEMA_VERSION) {
    const migration = MIGRATIONS[v];
    if (!migration) {
      throw new Error(`Missing migration from v${v} to v${v + 1}`);
    }
    current = migration(current);
    v += 1;
  }
  return current;
}
```

- [ ] **2.12: Verify version test passes**

Run: `pnpm --filter @manta/snapshot test version.test.ts`
Expected: 6/6 passing.

- [ ] **2.13: Write failing test for schema**

Create `packages/manta-snapshot/tests/schema.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { SnapshotSchema, TaskContractSchema } from '../src/schema';
import { CURRENT_SCHEMA_VERSION } from '../src/version';

const validContract = {
  cloneId: 'A',
  mode: 'recon-swarm',
  task: 'Map the codebase',
  scope: {
    allowedPaths: ['src/'],
    forbiddenPaths: ['secrets/'],
    maxFilesChanged: 0,
  },
  approachHint: null,
  siblingClones: [],
  deadlineSeconds: 1200,
};

const validSnapshot = {
  version: CURRENT_SCHEMA_VERSION,
  castId: 'cast-001',
  parentSessionId: 'session-abc',
  parentPid: 12345,
  createdAt: '2026-05-06T10:00:00.000Z',
  taskContract: validContract,
  recentMessages: [],
  activeTodos: [],
  openFiles: [],
  parentWorktree: '/tmp/parent',
  cloneWorktree: '/tmp/clone-A',
  mode: 'recon-swarm',
  budget: { tokensTotal: 100000, tokensUsed: 0, dollarsTotal: 5, dollarsUsed: 0 },
  ttlSeconds: 1200,
  siblingCloneIds: [],
};

describe('TaskContractSchema', () => {
  it('accepts a valid contract', () => {
    expect(() => TaskContractSchema.parse(validContract)).not.toThrow();
  });

  it('rejects unknown mode', () => {
    expect(() => TaskContractSchema.parse({ ...validContract, mode: 'wat' })).toThrow();
  });

  it('rejects negative deadline', () => {
    expect(() => TaskContractSchema.parse({ ...validContract, deadlineSeconds: -1 })).toThrow();
  });

  it('rejects empty cloneId', () => {
    expect(() => TaskContractSchema.parse({ ...validContract, cloneId: '' })).toThrow();
  });
});

describe('SnapshotSchema', () => {
  it('accepts a valid snapshot', () => {
    expect(() => SnapshotSchema.parse(validSnapshot)).not.toThrow();
  });

  it('rejects mismatched version', () => {
    expect(() => SnapshotSchema.parse({ ...validSnapshot, version: 999 })).toThrow();
  });

  it('rejects mismatched mode in contract vs root', () => {
    expect(() =>
      SnapshotSchema.parse({
        ...validSnapshot,
        mode: 'forking-realities',
        taskContract: { ...validContract, mode: 'recon-swarm' },
      }),
    ).toThrow(/mode/i);
  });

  it('rejects parentPid that is not positive integer', () => {
    expect(() => SnapshotSchema.parse({ ...validSnapshot, parentPid: 0 })).toThrow();
    expect(() => SnapshotSchema.parse({ ...validSnapshot, parentPid: 1.5 })).toThrow();
  });

  it('rejects createdAt that is not ISO 8601', () => {
    expect(() => SnapshotSchema.parse({ ...validSnapshot, createdAt: 'yesterday' })).toThrow();
  });
});
```

- [ ] **2.14: Run schema test — must fail**

Run: `pnpm --filter @manta/snapshot test schema.test.ts`
Expected: FAIL — module not found.

- [ ] **2.15: Implement `src/schema.ts`**

```typescript
import { z } from 'zod';
import { CURRENT_SCHEMA_VERSION } from './version';

export const ModeSchema = z.enum([
  'recon-swarm',
  'forking-realities',
  'pair-programming',
  'test-storm',
  'bug-hunt',
  'refactor-wave',
  'documentation-chase',
  'phantom-lance',
  'council',
  'decoy',
]);

export type Mode = z.infer<typeof ModeSchema>;

export const ScopeSchema = z.object({
  allowedPaths: z.array(z.string().min(1)).min(1),
  forbiddenPaths: z.array(z.string().min(1)),
  maxFilesChanged: z.number().int().nonnegative(),
});

export const TaskContractSchema = z.object({
  cloneId: z.string().min(1),
  mode: ModeSchema,
  task: z.string().min(1),
  scope: ScopeSchema,
  approachHint: z.string().nullable(),
  siblingClones: z.array(z.string().min(1)),
  deadlineSeconds: z.number().int().positive(),
});

export type TaskContract = z.infer<typeof TaskContractSchema>;

export const TodoSchema = z.object({
  id: z.string().min(1),
  subject: z.string().min(1),
  status: z.enum(['pending', 'in_progress', 'completed']),
});

export const MessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'tool', 'system']),
  content: z.string(),
  timestamp: z.string().datetime(),
});

export const OpenFileSchema = z.object({
  path: z.string().min(1),
  reason: z.string().min(1),
});

export const BudgetSchema = z.object({
  tokensTotal: z.number().int().nonnegative(),
  tokensUsed: z.number().int().nonnegative(),
  dollarsTotal: z.number().nonnegative(),
  dollarsUsed: z.number().nonnegative(),
});

export const SnapshotSchema = z
  .object({
    version: z.literal(CURRENT_SCHEMA_VERSION),
    castId: z.string().min(1),
    parentSessionId: z.string().min(1),
    parentPid: z.number().int().positive(),
    createdAt: z.string().datetime(),
    taskContract: TaskContractSchema,
    recentMessages: z.array(MessageSchema),
    activeTodos: z.array(TodoSchema),
    openFiles: z.array(OpenFileSchema),
    parentWorktree: z.string().min(1),
    cloneWorktree: z.string().min(1),
    mode: ModeSchema,
    budget: BudgetSchema,
    ttlSeconds: z.number().int().positive(),
    siblingCloneIds: z.array(z.string().min(1)),
  })
  .refine((s) => s.mode === s.taskContract.mode, {
    message: 'snapshot.mode must equal snapshot.taskContract.mode',
    path: ['mode'],
  });

export type Snapshot = z.infer<typeof SnapshotSchema>;

// Inferred type re-exports for downstream callers (manta-cli, manta-orchestrator)
export type Scope = z.infer<typeof ScopeSchema>;
export type Todo = z.infer<typeof TodoSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type OpenFile = z.infer<typeof OpenFileSchema>;
export type Budget = z.infer<typeof BudgetSchema>;
```

- [ ] **2.16: Verify schema test passes**

Run: `pnpm --filter @manta/snapshot test schema.test.ts`
Expected: 9/9 passing.

- [ ] **2.17: Write failing test for `errors.ts`**

Create `packages/manta-snapshot/tests/errors.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  SnapshotValidationError,
  SnapshotIOError,
  SnapshotVersionError,
} from '../src/errors';

describe('error classes', () => {
  it('SnapshotValidationError carries zod issues', () => {
    const err = new SnapshotValidationError('bad', [{ code: 'custom', path: ['mode'], message: 'x' }]);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SnapshotValidationError');
    expect(err.issues).toHaveLength(1);
  });

  it('SnapshotIOError carries underlying cause', () => {
    const cause = new Error('ENOENT');
    const err = new SnapshotIOError('cannot read', cause);
    expect(err.cause).toBe(cause);
    expect(err.name).toBe('SnapshotIOError');
  });

  it('SnapshotVersionError carries version info', () => {
    const err = new SnapshotVersionError(99, 1);
    expect(err.foundVersion).toBe(99);
    expect(err.expectedVersion).toBe(1);
    expect(err.message).toMatch(/99/);
  });
});
```

- [ ] **2.18: Run errors test — must fail**

Run: `pnpm --filter @manta/snapshot test errors.test.ts`
Expected: FAIL — module not found.

- [ ] **2.19: Implement `src/errors.ts`**

```typescript
import type { ZodIssue } from 'zod';

export class SnapshotValidationError extends Error {
  override readonly name = 'SnapshotValidationError';
  constructor(message: string, public readonly issues: ZodIssue[]) {
    super(message);
  }
}

export class SnapshotIOError extends Error {
  override readonly name = 'SnapshotIOError';
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
  }
}

export class SnapshotVersionError extends Error {
  override readonly name = 'SnapshotVersionError';
  constructor(public readonly foundVersion: number, public readonly expectedVersion: number) {
    super(
      `Snapshot version mismatch: found v${foundVersion}, expected v${expectedVersion}`,
    );
  }
}
```

- [ ] **2.20: Verify errors test passes**

Run: `pnpm --filter @manta/snapshot test errors.test.ts`
Expected: 3/3 passing.

- [ ] **2.21: Write failing test for `serialize.ts`**

Create `packages/manta-snapshot/tests/serialize.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serializeSnapshot } from '../src/serialize';
import { SnapshotValidationError, SnapshotIOError } from '../src/errors';
import { CURRENT_SCHEMA_VERSION } from '../src/version';
import type { Snapshot } from '../src/schema';

const valid: Snapshot = {
  version: CURRENT_SCHEMA_VERSION,
  castId: 'cast-001',
  parentSessionId: 'session-abc',
  parentPid: 12345,
  createdAt: '2026-05-06T10:00:00.000Z',
  taskContract: {
    cloneId: 'A',
    mode: 'recon-swarm',
    task: 'Map repo',
    scope: { allowedPaths: ['src/'], forbiddenPaths: [], maxFilesChanged: 0 },
    approachHint: null,
    siblingClones: [],
    deadlineSeconds: 1200,
  },
  recentMessages: [],
  activeTodos: [],
  openFiles: [],
  parentWorktree: '/tmp/parent',
  cloneWorktree: '/tmp/clone-A',
  mode: 'recon-swarm',
  budget: { tokensTotal: 100000, tokensUsed: 0, dollarsTotal: 5, dollarsUsed: 0 },
  ttlSeconds: 1200,
  siblingCloneIds: [],
};

describe('serializeSnapshot', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'manta-snap-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a valid snapshot to disk', async () => {
    const path = join(dir, 'snap.json');
    await serializeSnapshot(valid, path);
    expect(existsSync(path)).toBe(true);
    const content = JSON.parse(readFileSync(path, 'utf-8')) as Snapshot;
    expect(content.castId).toBe('cast-001');
    expect(content.version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('writes formatted JSON (2-space indent)', async () => {
    const path = join(dir, 'snap.json');
    await serializeSnapshot(valid, path);
    const raw = readFileSync(path, 'utf-8');
    expect(raw).toContain('\n  "castId"');
  });

  it('rejects an invalid snapshot before writing', async () => {
    const path = join(dir, 'snap.json');
    // @ts-expect-error — intentionally malformed runtime input to trigger validation
    const bad: Snapshot = { ...valid, parentPid: -1 };
    await expect(serializeSnapshot(bad, path)).rejects.toBeInstanceOf(SnapshotValidationError);
    expect(existsSync(path)).toBe(false);
  });

  it('throws SnapshotIOError when destination dir cannot be created (path conflicts with existing file)', async () => {
    // Create a regular file, then attempt to write a snapshot into a path that treats it as a directory.
    // This is portable across macOS/Linux: mkdir fails on EEXIST/ENOTDIR.
    const fileBlocker = join(dir, 'blocker');
    writeFileSync(fileBlocker, 'i am a file');
    const blockedPath = join(fileBlocker, 'sub', 'snap.json');
    await expect(serializeSnapshot(valid, blockedPath)).rejects.toBeInstanceOf(SnapshotIOError);
  });
});
```

- [ ] **2.22: Run serialize test — must fail**

Run: `pnpm --filter @manta/snapshot test serialize.test.ts`
Expected: FAIL — module not found.

- [ ] **2.23: Implement `src/serialize.ts`**

```typescript
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SnapshotSchema, type Snapshot } from './schema';
import { SnapshotValidationError, SnapshotIOError } from './errors';

export async function serializeSnapshot(snapshot: Snapshot, destPath: string): Promise<void> {
  const result = SnapshotSchema.safeParse(snapshot);
  if (!result.success) {
    throw new SnapshotValidationError(
      'Snapshot failed validation before serialization',
      result.error.issues,
    );
  }

  const dir = dirname(destPath);
  try {
    await mkdir(dir, { recursive: true });
  } catch (cause) {
    throw new SnapshotIOError(`Cannot create snapshot directory: ${dir}`, cause);
  }

  const payload = JSON.stringify(result.data, null, 2);
  try {
    await writeFile(destPath, payload, { encoding: 'utf-8', flag: 'w' });
  } catch (cause) {
    throw new SnapshotIOError(`Cannot write snapshot to: ${destPath}`, cause);
  }
}
```

- [ ] **2.24: Verify serialize test passes**

Run: `pnpm --filter @manta/snapshot test serialize.test.ts`
Expected: 4/4 passing (the cleanup `it.skip` is expected to skip).

- [ ] **2.25: Write failing test for `deserialize.ts`**

Create `packages/manta-snapshot/tests/deserialize.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deserializeSnapshot } from '../src/deserialize';
import {
  SnapshotIOError,
  SnapshotValidationError,
  SnapshotVersionError,
} from '../src/errors';
import { CURRENT_SCHEMA_VERSION } from '../src/version';

describe('deserializeSnapshot', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'manta-snap-de-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads and validates a valid snapshot file', async () => {
    const valid = {
      version: CURRENT_SCHEMA_VERSION,
      castId: 'c1',
      parentSessionId: 's1',
      parentPid: 1,
      createdAt: '2026-05-06T10:00:00.000Z',
      taskContract: {
        cloneId: 'A',
        mode: 'recon-swarm',
        task: 'x',
        scope: { allowedPaths: ['src/'], forbiddenPaths: [], maxFilesChanged: 0 },
        approachHint: null,
        siblingClones: [],
        deadlineSeconds: 1200,
      },
      recentMessages: [],
      activeTodos: [],
      openFiles: [],
      parentWorktree: '/p',
      cloneWorktree: '/c',
      mode: 'recon-swarm',
      budget: { tokensTotal: 1, tokensUsed: 0, dollarsTotal: 1, dollarsUsed: 0 },
      ttlSeconds: 60,
      siblingCloneIds: [],
    };
    const path = join(dir, 'snap.json');
    writeFileSync(path, JSON.stringify(valid));
    const out = await deserializeSnapshot(path);
    expect(out.castId).toBe('c1');
  });

  it('throws SnapshotIOError when file does not exist', async () => {
    await expect(deserializeSnapshot(join(dir, 'missing.json'))).rejects.toBeInstanceOf(
      SnapshotIOError,
    );
  });

  it('throws SnapshotIOError on malformed JSON', async () => {
    const path = join(dir, 'bad.json');
    writeFileSync(path, '{not json');
    await expect(deserializeSnapshot(path)).rejects.toBeInstanceOf(SnapshotIOError);
  });

  it('throws SnapshotVersionError on unsupported future version', async () => {
    const path = join(dir, 'futureverz.json');
    writeFileSync(path, JSON.stringify({ version: 999, castId: 'c1' }));
    await expect(deserializeSnapshot(path)).rejects.toBeInstanceOf(SnapshotVersionError);
  });

  it('throws SnapshotValidationError on schema-invalid snapshot', async () => {
    const path = join(dir, 'invalid.json');
    writeFileSync(path, JSON.stringify({ version: CURRENT_SCHEMA_VERSION, castId: '' }));
    await expect(deserializeSnapshot(path)).rejects.toBeInstanceOf(SnapshotValidationError);
  });
});
```

- [ ] **2.26: Run deserialize test — must fail**

Run: `pnpm --filter @manta/snapshot test deserialize.test.ts`
Expected: FAIL.

- [ ] **2.27: Implement `src/deserialize.ts`**

```typescript
import { readFile } from 'node:fs/promises';
import { SnapshotSchema, type Snapshot } from './schema';
import {
  SnapshotIOError,
  SnapshotValidationError,
  SnapshotVersionError,
} from './errors';
import { CURRENT_SCHEMA_VERSION, isSupportedVersion, migrate } from './version';

export async function deserializeSnapshot(path: string): Promise<Snapshot> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (cause) {
    throw new SnapshotIOError(`Cannot read snapshot: ${path}`, cause);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new SnapshotIOError(`Snapshot is not valid JSON: ${path}`, cause);
  }

  // Version gate: must be present and a positive integer
  const versionField = (parsed as { version?: unknown })?.version;
  if (typeof versionField !== 'number' || !Number.isInteger(versionField)) {
    throw new SnapshotValidationError(
      'Snapshot is missing a numeric "version" field',
      [],
    );
  }
  if (!isSupportedVersion(versionField)) {
    throw new SnapshotVersionError(versionField, CURRENT_SCHEMA_VERSION);
  }

  const migrated = migrate(parsed, versionField);

  const result = SnapshotSchema.safeParse(migrated);
  if (!result.success) {
    throw new SnapshotValidationError(
      `Snapshot at ${path} failed schema validation`,
      result.error.issues,
    );
  }
  return result.data;
}
```

- [ ] **2.28: Verify deserialize test passes**

Run: `pnpm --filter @manta/snapshot test deserialize.test.ts`
Expected: 5/5 passing.

- [ ] **2.29: Write failing test for `capture.ts`**

Create `packages/manta-snapshot/tests/capture.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { captureState } from '../src/capture';
import { CURRENT_SCHEMA_VERSION } from '../src/version';

describe('captureState', () => {
  it('returns a snapshot with all required fields populated from input', () => {
    const snap = captureState({
      castId: 'cast-001',
      parentSessionId: 'session-abc',
      parentPid: 99,
      taskContract: {
        cloneId: 'A',
        mode: 'recon-swarm',
        task: 'Map repo',
        scope: { allowedPaths: ['src/'], forbiddenPaths: [], maxFilesChanged: 0 },
        approachHint: null,
        siblingClones: [],
        deadlineSeconds: 1200,
      },
      recentMessages: [],
      activeTodos: [],
      openFiles: [],
      parentWorktree: '/parent',
      cloneWorktree: '/clone-A',
      budget: { tokensTotal: 1, tokensUsed: 0, dollarsTotal: 1, dollarsUsed: 0 },
      ttlSeconds: 60,
      siblingCloneIds: [],
    });
    expect(snap.version).toBe(CURRENT_SCHEMA_VERSION);
    expect(snap.castId).toBe('cast-001');
    expect(snap.mode).toBe('recon-swarm');
    expect(snap.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('derives mode from taskContract.mode (single source of truth)', () => {
    const snap = captureState({
      castId: 'c',
      parentSessionId: 's',
      parentPid: 1,
      taskContract: {
        cloneId: 'B',
        mode: 'forking-realities',
        task: 't',
        scope: { allowedPaths: ['src/'], forbiddenPaths: [], maxFilesChanged: 0 },
        approachHint: null,
        siblingClones: [],
        deadlineSeconds: 1,
      },
      recentMessages: [],
      activeTodos: [],
      openFiles: [],
      parentWorktree: '/p',
      cloneWorktree: '/c',
      budget: { tokensTotal: 1, tokensUsed: 0, dollarsTotal: 1, dollarsUsed: 0 },
      ttlSeconds: 60,
      siblingCloneIds: [],
    });
    expect(snap.mode).toBe('forking-realities');
  });

  it('produces a value that passes SnapshotSchema validation (no manual validation needed)', async () => {
    const { SnapshotSchema } = await import('../src/schema');
    const snap = captureState({
      castId: 'c',
      parentSessionId: 's',
      parentPid: 1,
      taskContract: {
        cloneId: 'A',
        mode: 'recon-swarm',
        task: 't',
        scope: { allowedPaths: ['src/'], forbiddenPaths: [], maxFilesChanged: 0 },
        approachHint: null,
        siblingClones: [],
        deadlineSeconds: 1,
      },
      recentMessages: [],
      activeTodos: [],
      openFiles: [],
      parentWorktree: '/p',
      cloneWorktree: '/c',
      budget: { tokensTotal: 1, tokensUsed: 0, dollarsTotal: 1, dollarsUsed: 0 },
      ttlSeconds: 60,
      siblingCloneIds: [],
    });
    expect(() => SnapshotSchema.parse(snap)).not.toThrow();
  });
});
```

- [ ] **2.30: Run capture test — must fail**

Run: `pnpm --filter @manta/snapshot test capture.test.ts`
Expected: FAIL.

- [ ] **2.31: Implement `src/capture.ts`**

```typescript
import { CURRENT_SCHEMA_VERSION } from './version';
import type {
  Snapshot,
  TaskContract,
  Message,
  Todo,
  OpenFile,
  Budget,
} from './schema';

export interface CaptureInput {
  castId: string;
  parentSessionId: string;
  parentPid: number;
  taskContract: TaskContract;
  recentMessages: Message[];
  activeTodos: Todo[];
  openFiles: OpenFile[];
  parentWorktree: string;
  cloneWorktree: string;
  budget: Budget;
  ttlSeconds: number;
  siblingCloneIds: string[];
}

export function captureState(input: CaptureInput): Snapshot {
  return {
    version: CURRENT_SCHEMA_VERSION,
    castId: input.castId,
    parentSessionId: input.parentSessionId,
    parentPid: input.parentPid,
    createdAt: new Date().toISOString(),
    taskContract: input.taskContract,
    recentMessages: input.recentMessages,
    activeTodos: input.activeTodos,
    openFiles: input.openFiles,
    parentWorktree: input.parentWorktree,
    cloneWorktree: input.cloneWorktree,
    mode: input.taskContract.mode,
    budget: input.budget,
    ttlSeconds: input.ttlSeconds,
    siblingCloneIds: input.siblingCloneIds,
  };
}
```

Note: this depends on `schema.ts` exporting the inferred types `Message`, `Todo`, `OpenFile`, `Budget`. Task 2.15's schema already adds those re-exports. If the imports fail at compile time, double-check that section is in place.

- [ ] **2.32: Verify capture test passes**

Run: `pnpm --filter @manta/snapshot test capture.test.ts`
Expected: 3/3 passing. If imports fail at compile time, fix `schema.ts` exports (export `MessageSchema`, `TodoSchema`, `OpenFileSchema` as named exports — they already are per task 2.15).

- [ ] **2.33: Write failing test for `distill.ts`**

Create `packages/manta-snapshot/tests/distill.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { distillContext } from '../src/distill';

describe('distillContext', () => {
  it('keeps only the last N messages when over the limit', () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({
      role: 'user' as const,
      content: `msg-${i}`,
      timestamp: '2026-05-06T10:00:00.000Z',
    }));
    const out = distillContext({ messages, openFiles: [], maxRecentMessages: 10 });
    expect(out.recentMessages).toHaveLength(10);
    expect(out.recentMessages.length).toBe(10);
    const first = out.recentMessages[0];
    const last = out.recentMessages[9];
    if (!first || !last) throw new Error('expected 10 messages');
    expect(first.content).toBe('msg-40');
    expect(last.content).toBe('msg-49');
  });

  it('keeps all messages when under the limit', () => {
    const messages = [
      { role: 'user' as const, content: 'a', timestamp: '2026-05-06T10:00:00.000Z' },
      { role: 'assistant' as const, content: 'b', timestamp: '2026-05-06T10:00:01.000Z' },
    ];
    const out = distillContext({ messages, openFiles: [], maxRecentMessages: 10 });
    expect(out.recentMessages).toHaveLength(2);
  });

  it('filters open files to only those overlapping with allowedPaths', () => {
    const openFiles = [
      { path: 'src/a.ts', reason: 'r' },
      { path: 'docs/b.md', reason: 'r' },
      { path: 'secrets/c.env', reason: 'r' },
    ];
    const out = distillContext({
      messages: [],
      openFiles,
      maxRecentMessages: 10,
      allowedPaths: ['src/', 'docs/'],
    });
    expect(out.openFiles.map((f) => f.path)).toEqual(['src/a.ts', 'docs/b.md']);
  });

  it('returns all open files unfiltered when no allowedPaths provided', () => {
    const openFiles = [
      { path: 'src/a.ts', reason: 'r' },
      { path: 'secrets/c.env', reason: 'r' },
    ];
    const out = distillContext({ messages: [], openFiles, maxRecentMessages: 10 });
    expect(out.openFiles).toHaveLength(2);
  });

  it('throws on non-positive maxRecentMessages', () => {
    expect(() =>
      distillContext({ messages: [], openFiles: [], maxRecentMessages: 0 }),
    ).toThrow(/maxRecentMessages/);
  });
});
```

- [ ] **2.34: Run distill test — must fail**

Run: `pnpm --filter @manta/snapshot test distill.test.ts`
Expected: FAIL.

- [ ] **2.35: Implement `src/distill.ts`**

```typescript
import type { z } from 'zod';
import type { MessageSchema, OpenFileSchema } from './schema';

type Message = z.infer<typeof MessageSchema>;
type OpenFile = z.infer<typeof OpenFileSchema>;

export interface DistillInput {
  messages: Message[];
  openFiles: OpenFile[];
  maxRecentMessages: number;
  allowedPaths?: string[];
}

export interface DistillOutput {
  recentMessages: Message[];
  openFiles: OpenFile[];
}

export function distillContext(input: DistillInput): DistillOutput {
  if (!Number.isInteger(input.maxRecentMessages) || input.maxRecentMessages <= 0) {
    throw new Error(
      `distillContext: maxRecentMessages must be a positive integer (got ${input.maxRecentMessages})`,
    );
  }

  const recentMessages =
    input.messages.length > input.maxRecentMessages
      ? input.messages.slice(input.messages.length - input.maxRecentMessages)
      : [...input.messages];

  const openFiles = input.allowedPaths
    ? input.openFiles.filter((f) => input.allowedPaths!.some((p) => f.path.startsWith(p)))
    : [...input.openFiles];

  return { recentMessages, openFiles };
}
```

- [ ] **2.36: Verify distill test passes**

Run: `pnpm --filter @manta/snapshot test distill.test.ts`
Expected: 5/5 passing.

- [ ] **2.37: Write round-trip integration test**

Create `packages/manta-snapshot/tests/round-trip.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureState,
  serializeSnapshot,
  deserializeSnapshot,
} from '../src/index';
import { CURRENT_SCHEMA_VERSION } from '../src/version';

describe('snapshot round-trip', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'manta-rt-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('captures, serializes, deserializes, and produces an equivalent snapshot', async () => {
    const captured = captureState({
      castId: 'cast-RT',
      parentSessionId: 'session-RT',
      parentPid: 4242,
      taskContract: {
        cloneId: 'A',
        mode: 'recon-swarm',
        task: 'roundtrip',
        scope: { allowedPaths: ['src/'], forbiddenPaths: ['secrets/'], maxFilesChanged: 0 },
        approachHint: 'depth-first',
        siblingClones: ['B'],
        deadlineSeconds: 600,
      },
      recentMessages: [
        { role: 'user', content: 'hi', timestamp: '2026-05-06T10:00:00.000Z' },
      ],
      activeTodos: [{ id: 't1', subject: 'do', status: 'pending' }],
      openFiles: [{ path: 'src/x.ts', reason: 'open' }],
      parentWorktree: '/p',
      cloneWorktree: '/c',
      budget: { tokensTotal: 1000, tokensUsed: 100, dollarsTotal: 5, dollarsUsed: 0.5 },
      ttlSeconds: 600,
      siblingCloneIds: ['B'],
    });

    const path = join(dir, 'rt.json');
    await serializeSnapshot(captured, path);
    const restored = await deserializeSnapshot(path);

    expect(restored.version).toBe(CURRENT_SCHEMA_VERSION);
    expect(restored).toEqual(captured);
  });
});
```

- [ ] **2.38: Run round-trip test — must fail (index.ts missing exports)**

Run: `pnpm --filter @manta/snapshot test round-trip.test.ts`
Expected: FAIL — module exports not found.

- [ ] **2.39: Implement `src/index.ts`**

```typescript
export { captureState, type CaptureInput } from './capture';
export { serializeSnapshot } from './serialize';
export { deserializeSnapshot } from './deserialize';
export { distillContext, type DistillInput, type DistillOutput } from './distill';
export {
  SnapshotSchema,
  TaskContractSchema,
  ScopeSchema,
  ModeSchema,
  TodoSchema,
  MessageSchema,
  OpenFileSchema,
  BudgetSchema,
  type Snapshot,
  type TaskContract,
  type Mode,
  type Scope,
  type Todo,
  type Message,
  type OpenFile,
  type Budget,
} from './schema';
export {
  SnapshotValidationError,
  SnapshotIOError,
  SnapshotVersionError,
} from './errors';
export { CURRENT_SCHEMA_VERSION } from './version';
```

- [ ] **2.40: Verify round-trip test passes**

Run: `pnpm --filter @manta/snapshot test round-trip.test.ts`
Expected: 1/1 passing.

- [ ] **2.41: Run full package test suite + coverage**

Run: `pnpm --filter @manta/snapshot test:coverage`
Expected: ALL tests pass. Coverage report shows ≥ 80% lines/functions/branches/statements on `src/*.ts` (excluding `src/index.ts`). If any threshold fails: write missing tests in the relevant `tests/*.test.ts` until coverage ≥ 80%.

- [ ] **2.42: Verify build produces dist artifacts**

Run: `pnpm --filter @manta/snapshot build`
Expected: `packages/manta-snapshot/dist/` contains `index.cjs`, `index.js`, `index.d.ts`. No build errors.

- [ ] **2.43: Verify package lint clean**

Run: `pnpm --filter @manta/snapshot lint`
Expected: zero errors, zero warnings. Fix any reported issues before commit.

- [ ] **2.44: Verify package typecheck clean**

Run: `pnpm --filter @manta/snapshot typecheck`
Expected: succeeds with no errors.

- [ ] **2.45: Write `packages/manta-snapshot/README.md`**

Use the `Write` tool with the following content (verbatim, including triple backticks):

````markdown
# @manta/snapshot

Versioned, validated state + transcript serializer for Manta clones.

## Install

Internal package in the Manta monorepo. Other packages depend on it via `workspace:*`.

## Usage

```typescript
import { captureState, serializeSnapshot, deserializeSnapshot } from '@manta/snapshot';

const snap = captureState({ /* ... */ });
await serializeSnapshot(snap, '/tmp/snap.json');
const restored = await deserializeSnapshot('/tmp/snap.json');
```

## API

- `captureState(input: CaptureInput): Snapshot` — build a snapshot from current state. Pure.
- `serializeSnapshot(snap, path)` — validate and write JSON to disk.
- `deserializeSnapshot(path): Promise<Snapshot>` — read, version-check, validate, return.
- `distillContext(input)` — shrink messages + openFiles for transmittable subset.

## Errors

- `SnapshotValidationError` — schema validation failed (carries `issues: ZodIssue[]`).
- `SnapshotIOError` — filesystem / JSON parse failure (carries `cause`).
- `SnapshotVersionError` — file version not supported by this build.

## Schema versioning

Version constant: `CURRENT_SCHEMA_VERSION` (currently 1). Migration table in `src/version.ts`. When bumping, add a migration entry; old snapshots remain readable for at least 2 release cycles per CLAUDE.md PROD policy.
````

(The outer 4-backtick fence in this task is a markdown escape — the resulting README starts with `# @manta/snapshot` and uses normal triple-backtick code fences inside.)

- [ ] **2.46: Write `packages/manta-snapshot/ARCHITECTURE.md`**

```markdown
# manta-snapshot — Architecture

## Why this package exists

A Manta cast spawns headless `claude --print` clones. Each clone receives initial context as a snapshot file. This package owns the snapshot format end-to-end.

## Boundaries

- **In scope:** schema, capture, serialize, deserialize, distill, version migration.
- **Out of scope:** producing the actual transcript / open-file list (that's the orchestrator's job — this package just types it). Process spawning (manta-cli). Bus communication (manta-bus).

## Module map

| File | Responsibility |
|---|---|
| `schema.ts` | Zod schemas + inferred TS types. Pure data definition. |
| `capture.ts` | Build a Snapshot from a CaptureInput (caller-provided data). |
| `serialize.ts` | Validate + write JSON to disk. |
| `deserialize.ts` | Read + parse + version-migrate + validate. |
| `distill.ts` | Shrink message history + filter files for transmission. |
| `version.ts` | Schema version constant + migration registry. |
| `errors.ts` | Typed errors for narrowing failure modes. |
| `index.ts` | Public re-exports only. No logic. |

## Design choices

- **Validate at boundaries**: `serializeSnapshot` validates before write; `deserializeSnapshot` validates after read. This catches drift between in-process objects (which strict TS guards) and disk JSON (which has no compile-time guarantees).
- **Version field is required and integer**: any snapshot without a numeric `version` is rejected. Future versions are explicitly rejected (forward-incompatible reads are unsafe).
- **Migrations are explicit**: each version bump must register a migration. No "best-effort" reads of old data.
- **`mode` redundancy is enforced**: `snapshot.mode === snapshot.taskContract.mode` via zod refine. Single source of truth from caller's perspective; redundant on disk for human readability.
- **No filesystem in `capture.ts`**: caller provides all data. Keeps the function pure and testable without temp files.

## Test strategy

- Unit tests per module (`schema`, `capture`, `serialize`, `deserialize`, `distill`, `version`, `errors`).
- Round-trip integration test (`round-trip.test.ts`) — capture → serialize → deserialize → equality.
- Coverage threshold ≥ 80% on lines/functions/branches/statements (excluding `index.ts`).
```

- [ ] **2.47: Run final package test sweep**

Run from repo root: `pnpm --filter @manta/snapshot test:coverage && pnpm --filter @manta/snapshot lint && pnpm --filter @manta/snapshot typecheck && pnpm --filter @manta/snapshot build`
Expected: all four succeed.

- [ ] **2.48: Commit Chunk 2**

```bash
git -c user.email="tr00x@proton.me" -c user.name="Tim Hunt" add \
  packages/manta-snapshot \
  tsconfig.json pnpm-lock.yaml
git -c user.email="tr00x@proton.me" -c user.name="Tim Hunt" commit -m "$(cat <<'EOF'
feat(snapshot): add versioned state serializer for Manta clones

- Zod-validated Snapshot schema (mode, contract, messages, files, budget, TTL)
- captureState / serializeSnapshot / deserializeSnapshot / distillContext
- Versioned with explicit migration table; forward-incompat reads rejected
- Typed errors: SnapshotValidationError, SnapshotIOError, SnapshotVersionError
- Round-trip integration test, coverage ≥ 80% on critical paths

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Run: `git log --oneline -3` — verify Chunk 2 commit landed on top of Chunk 1.

---

