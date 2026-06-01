import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Bug #M9: the merge-review quality gate was hardcoded to Manta's OWN
 * pnpm-monorepo toolchain (`pnpm install` / `pnpm -r build` / `pnpm test` /
 * `pnpm typecheck` / `pnpm exec eslint`). Against any non-JS project (Python,
 * Go, Rust, …) `pnpm test` errored instantly → every forking-realities
 * candidate was silently disqualified on `test_gate` → `no_candidates_passed_gate`
 * on EVERY cast. The headline auto-promote feature was non-functional for the
 * whole non-JS world.
 *
 * This detector inspects the worktree root for project-type markers and returns
 * the matching gate commands for ALL quality axes — install, build, test,
 * typecheck, lint — not just the test step. A `null` command means "this axis
 * is not applicable to this project type"; the collector treats it as SKIPPED
 * (neutral), never a failure. Every gate command is also run ENOENT-safe by the
 * collector: if the tool isn't installed, the axis is skipped, never penalised.
 *
 * Detection order is specific-to-general: a pnpm workspace is detected before a
 * bare package.json, so Manta's own repo keeps its exact canonical gate.
 */
export type ArgvCommand = readonly [string, ...string[]];

/** How to turn a gate command's output into an error count. */
export type ErrorParser = 'tsc' | 'eslint-json' | 'exit-code';

export interface Toolchain {
  /** Human label for logs/verdicts. */
  kind: 'pnpm' | 'npm' | 'python' | 'cargo' | 'go' | 'unknown';
  /** Install deps before the gate, or null if none / not applicable. */
  install: ArgvCommand | null;
  /** Build step before the gate, or null. */
  build: ArgvCommand | null;
  /** Test command. null = no detectable test gate → SKIPPED, never a failure. */
  test: ArgvCommand | null;
  /** Type/compile check (tsc, cargo check, go vet). null = not applicable. */
  typecheck: ArgvCommand | null;
  /** How to count errors from the typecheck command's output. */
  typecheckParser: ErrorParser;
  /** Lint command (eslint, …). null = not applicable / tool not assumed present. */
  lint: ArgvCommand | null;
  /** How to count warnings/errors from the lint command's output. */
  lintParser: ErrorParser;
}

function has(root: string, name: string): boolean {
  return existsSync(join(root, name));
}

function packageJsonHasTestScript(root: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as {
      scripts?: Record<string, string>;
    };
    return typeof pkg.scripts?.test === 'string' && pkg.scripts.test.trim().length > 0;
  } catch {
    return false;
  }
}

function hasEslintConfig(root: string): boolean {
  return (
    has(root, '.eslintrc.js') ||
    has(root, '.eslintrc.cjs') ||
    has(root, '.eslintrc.json') ||
    has(root, '.eslintrc.yml') ||
    has(root, '.eslintrc.yaml') ||
    has(root, 'eslint.config.js') ||
    has(root, 'eslint.config.mjs') ||
    has(root, 'eslint.config.cjs')
  );
}

export function detectToolchain(worktreePath: string): Toolchain {
  // pnpm workspace (Manta's own shape) — keep the exact canonical gate.
  if (has(worktreePath, 'pnpm-lock.yaml') || has(worktreePath, 'pnpm-workspace.yaml')) {
    return {
      kind: 'pnpm',
      install: ['pnpm', 'install', '--frozen-lockfile', '--prefer-offline'],
      build: ['pnpm', '-r', '--filter', './packages/*', 'build'],
      test: ['pnpm', 'test'],
      typecheck: ['pnpm', 'typecheck'],
      typecheckParser: 'tsc',
      // Canonical gate lint scope (bug #63): packages/**/src, JSON output, bound
      // to the workspace eslint via `pnpm exec`.
      lint: [
        'pnpm',
        'exec',
        'eslint',
        'packages/**/src/**/*.ts',
        '--no-error-on-unmatched-pattern',
        '--format',
        'json',
      ],
      lintParser: 'eslint-json',
    };
  }

  // Plain npm/yarn project.
  if (has(worktreePath, 'package.json')) {
    const isTs = has(worktreePath, 'tsconfig.json') || has(worktreePath, 'tsconfig.base.json');
    return {
      kind: 'npm',
      install: has(worktreePath, 'package-lock.json') ? ['npm', 'ci'] : ['npm', 'install'],
      build: null, // a bare package.json may have no build; tsc covers compile-check below
      test: packageJsonHasTestScript(worktreePath) ? ['npm', 'test'] : null,
      // A TS project type-checks with `tsc --noEmit` regardless of package
      // manager — run it via npx so it isn't pnpm-specific.
      typecheck: isTs ? ['npx', '--no-install', 'tsc', '--noEmit'] : null,
      typecheckParser: 'tsc',
      // Only lint when the project actually ships an eslint config — running
      // eslint on a project that doesn't use it would error spuriously.
      lint: hasEslintConfig(worktreePath)
        ? ['npx', '--no-install', 'eslint', '.', '--no-error-on-unmatched-pattern', '--format', 'json']
        : null,
      lintParser: 'eslint-json',
    };
  }

  // Python: pyproject.toml or setup.py → pytest. typecheck/lint are left null:
  // mypy/ruff are optional and not implied by the markers we detect, and a
  // missing tool must not penalise the candidate. pytest is the real gate.
  if (has(worktreePath, 'pyproject.toml') || has(worktreePath, 'setup.py')) {
    return {
      kind: 'python',
      install: ['pip', 'install', '-e', '.'],
      build: null,
      test: ['python', '-m', 'pytest', '-q'],
      typecheck: null,
      typecheckParser: 'exit-code',
      lint: null,
      lintParser: 'exit-code',
    };
  }

  // Rust: `cargo check` is the compile/type gate, `cargo test` the test gate.
  // (clippy is the lint tool but optional — left null so a clippy-less toolchain
  // isn't penalised.)
  if (has(worktreePath, 'Cargo.toml')) {
    return {
      kind: 'cargo',
      install: null, // cargo fetches+builds as needed
      build: ['cargo', 'build'],
      test: ['cargo', 'test'],
      typecheck: ['cargo', 'check'],
      typecheckParser: 'exit-code',
      lint: null,
      lintParser: 'exit-code',
    };
  }

  // Go: `go vet ./...` is the standard static-analysis/lint gate; `go build`
  // covers compile; `go test ./...` the test gate.
  if (has(worktreePath, 'go.mod')) {
    return {
      kind: 'go',
      install: null,
      build: ['go', 'build', './...'],
      test: ['go', 'test', './...'],
      typecheck: ['go', 'build', './...'],
      typecheckParser: 'exit-code',
      lint: ['go', 'vet', './...'],
      lintParser: 'exit-code',
    };
  }

  // Nothing recognised — no gate at all. The candidate is NOT disqualified
  // (test skipped) and no quality axis penalises it.
  return {
    kind: 'unknown',
    install: null,
    build: null,
    test: null,
    typecheck: null,
    typecheckParser: 'exit-code',
    lint: null,
    lintParser: 'exit-code',
  };
}
