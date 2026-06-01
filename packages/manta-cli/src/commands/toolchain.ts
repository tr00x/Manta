import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Bug #M9: the merge-review quality gate was hardcoded to Manta's OWN
 * pnpm-monorepo toolchain (`pnpm install` / `pnpm -r build` / `pnpm test` /
 * `pnpm typecheck` / `pnpm exec eslint`). Against any non-JS project (Python,
 * Go, Rust, …) `pnpm test` errors instantly → every forking-realities
 * candidate was silently disqualified on `test_gate` → `no_candidates_passed_gate`
 * on EVERY cast. The headline auto-promote feature was non-functional for the
 * whole non-JS world, and silently (it read as "both clones failed their tests"
 * when the tests never ran).
 *
 * This detector inspects the worktree root for project-type markers and returns
 * the matching gate commands. `null` for a step means "not applicable to this
 * project type" — the caller treats a null test step as a SKIPPED gate (the
 * candidate survives scoring) rather than a FAILED one, and skips the
 * TS-specific typecheck/lint metrics for non-TS projects so they aren't
 * penalised for not being TypeScript.
 *
 * Detection order is specific-to-general: a pnpm workspace is detected before a
 * bare package.json, so Manta's own repo keeps its exact canonical gate.
 */
export type ArgvCommand = readonly [string, ...string[]];

export interface Toolchain {
  /** Human label for logs/verdicts. */
  kind: 'pnpm' | 'npm' | 'python' | 'cargo' | 'go' | 'unknown';
  /** Install deps before the gate, or null if none / not applicable. */
  install: ArgvCommand | null;
  /** Build step before the gate, or null. */
  build: ArgvCommand | null;
  /** Test command. null = no detectable test gate → SKIPPED, never a failure. */
  test: ArgvCommand | null;
  /** True only for TS/JS projects — gates the tsc + eslint metric dimensions. */
  isTypeScript: boolean;
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

export function detectToolchain(worktreePath: string): Toolchain {
  // pnpm workspace (Manta's own shape) — keep the exact canonical gate.
  if (has(worktreePath, 'pnpm-lock.yaml') || has(worktreePath, 'pnpm-workspace.yaml')) {
    return {
      kind: 'pnpm',
      install: ['pnpm', 'install', '--frozen-lockfile', '--prefer-offline'],
      build: ['pnpm', '-r', '--filter', './packages/*', 'build'],
      test: ['pnpm', 'test'],
      isTypeScript: true,
    };
  }

  // Plain npm project with a real test script.
  if (has(worktreePath, 'package.json')) {
    return {
      kind: 'npm',
      install: has(worktreePath, 'package-lock.json') ? ['npm', 'ci'] : ['npm', 'install'],
      build: null, // a bare package.json may have no build; tsc step is skipped unless present
      test: packageJsonHasTestScript(worktreePath) ? ['npm', 'test'] : null,
      isTypeScript:
        has(worktreePath, 'tsconfig.json') ||
        has(worktreePath, 'tsconfig.base.json'),
    };
  }

  // Python: pyproject.toml or setup.py → pytest. Install best-effort editable so
  // the package is importable in the worktree (the env-seeding caveat from #M6
  // still applies: a worktree has no .venv; `pip install -e .` into the ambient
  // interpreter is the best-effort path, errors are swallowed by the caller).
  if (has(worktreePath, 'pyproject.toml') || has(worktreePath, 'setup.py')) {
    return {
      kind: 'python',
      install: ['pip', 'install', '-e', '.'],
      build: null,
      test: ['python', '-m', 'pytest', '-q'],
      isTypeScript: false,
    };
  }

  // Rust.
  if (has(worktreePath, 'Cargo.toml')) {
    return {
      kind: 'cargo',
      install: null, // cargo test fetches+builds as needed
      build: ['cargo', 'build'],
      test: ['cargo', 'test'],
      isTypeScript: false,
    };
  }

  // Go.
  if (has(worktreePath, 'go.mod')) {
    return {
      kind: 'go',
      install: null,
      build: ['go', 'build', './...'],
      test: ['go', 'test', './...'],
      isTypeScript: false,
    };
  }

  // Nothing recognised — no gate. The candidate is NOT disqualified (skipped),
  // and TS metrics are off so a non-TS tree isn't penalised.
  return { kind: 'unknown', install: null, build: null, test: null, isTypeScript: false };
}
