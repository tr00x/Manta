import { execa } from 'execa';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MetricCollector, RawCandidateMetrics } from '@manta/orchestrator';

const INSTALL_TIMEOUT_MS = 300_000;
const BUILD_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 300_000;
const TSC_TIMEOUT_MS = 120_000;
const ESLINT_TIMEOUT_MS = 60_000;
const GIT_TIMEOUT_MS = 10_000;

type CollectedMetrics = Omit<RawCandidateMetrics, 'selfCertainty'>;

/**
 * bug #63 root-cause fix. The merge-scorer's quality gate must reproduce the
 * canonical pre-merge `pnpm gate`, which assumes an INSTALLED and BUILT
 * workspace. A freshly `git worktree add`ed clone tree has no `node_modules`
 * or `dist/`, so the `@manta/*` build-time aliases resolve to nothing:
 * `tsc` reds with TS2307 ("Cannot find module '@manta/bus'") and the test step
 * trips the fresh-install heartbeat-hook path (bug #53). Both are false-REDs
 * against good, committed work — they false-negatived RB2 Chunks 2/3/4 and
 * forced a manual curator override on every cast (`no_candidates_passed_gate`).
 *
 * Install deps and build the workspace BEFORE measuring tsc/lint/test, so the
 * gate scores real quality, not missing build artifacts. Errors here are
 * intentionally swallowed (`reject: false`): a worktree that genuinely cannot
 * install or build will surface as tsc/test RED downstream — the correct
 * (true-RED) signal — rather than throwing the candidate out of scoring.
 *
 * Exported so the merge-all gate (`cast.ts` runQualityGate) shares the exact
 * same build prerequisite — one source of truth for "prepare like the canonical
 * gate".
 */
/**
 * bug #35 re-exposed (by the bug #63 fix). The merge-scorer gates ALL candidates
 * concurrently (`cast.ts` runs `collector.collect` for every clone via
 * `Promise.all`), so without serialization `prepareWorktreeForGate` fires N
 * concurrent `pnpm install`s against the shared content-addressable `.pnpm`
 * store — the exact race `pnpm-workspace.yaml` documents (symlink rewrite →
 * `ERR_MODULE_NOT_FOUND`). This process-wide promise-chain mutex serializes the
 * install+build prepare across all candidates so no two run at once. The chain
 * never breaks on a rejected run (each link swallows its own outcome) so one
 * candidate's failure cannot deadlock the others.
 */
let prepareChain: Promise<unknown> = Promise.resolve();
function runSerialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = prepareChain.then(fn, fn);
  prepareChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function prepareWorktreeForGate(worktreePath: string): Promise<void> {
  await runSerialized(async () => {
    // --frozen-lockfile: the worktree is checked out from a committed branch
    // whose pnpm-lock.yaml is authoritative; a warm store makes this a near-noop
    // and it can NEVER rewrite the tracked lockfile (which would dirty
    // `git diff --stat HEAD` in the diff-size metric). --prefer-offline keeps it
    // store-local.
    await execa('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], {
      cwd: worktreePath,
      timeout: INSTALL_TIMEOUT_MS,
      reject: false,
    });
    await execa('pnpm', ['-r', '--filter', './packages/*', 'build'], {
      cwd: worktreePath,
      timeout: BUILD_TIMEOUT_MS,
      reject: false,
    });
  });
}

async function runTests(worktreePath: string): Promise<boolean> {
  try {
    // bug #63: canonical gate test step = root `pnpm test` (`vitest run
    // --passWithNoTests`), mirroring `pnpm gate` exactly — not an ad-hoc
    // per-package `pnpm -r test`.
    await execa('pnpm', ['test'], { cwd: worktreePath, timeout: TEST_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

async function readCoverageDelta(worktreePath: string): Promise<number> {
  try {
    const raw = await readFile(join(worktreePath, 'coverage', 'coverage-summary.json'), 'utf-8');
    const summary = JSON.parse(raw) as { total?: { lines?: { pct?: number } } };
    return summary.total?.lines?.pct ?? 0;
  } catch {
    return 0;
  }
}

async function readDiffSize(worktreePath: string, baseBranch: string): Promise<number> {
  try {
    const r = await execa('git', ['diff', '--numstat', baseBranch], {
      cwd: worktreePath,
      timeout: GIT_TIMEOUT_MS,
    });
    let total = 0;
    for (const line of r.stdout.split('\n')) {
      const parts = line.split('\t');
      if (parts.length < 2) continue;
      const added = parseInt(parts[0]!, 10) || 0;
      const removed = parseInt(parts[1]!, 10) || 0;
      total += added + removed;
    }
    return total;
  } catch {
    return 0;
  }
}

async function readComplexityDelta(worktreePath: string, baseBranch: string): Promise<number> {
  try {
    const r = await execa('git', ['diff', '--name-only', baseBranch], {
      cwd: worktreePath,
      timeout: GIT_TIMEOUT_MS,
    });
    const tsFiles = r.stdout
      .split('\n')
      .filter((f) => /\.(ts|tsx|js|jsx)$/.test(f))
      .filter((f) => f.length > 0);

    if (tsFiles.length === 0) return 0;

    const diffResult = await execa('git', ['diff', '-U0', baseBranch, '--', ...tsFiles], {
      cwd: worktreePath,
      timeout: GIT_TIMEOUT_MS,
    });

    const pattern = /\b(if|else|for|while|switch|case|catch)\b|&&|\|\||\?(?![.:])/g;
    let count = 0;
    for (const line of diffResult.stdout.split('\n')) {
      if (!line.startsWith('+') || line.startsWith('+++')) continue;
      const matches = line.match(pattern);
      if (matches) count += matches.length;
    }
    return count;
  } catch {
    return 0;
  }
}

async function readTscErrors(worktreePath: string): Promise<number> {
  try {
    // bug #63: canonical typecheck = `tsc -b` (builds + checks project
    // references), NOT `tsc --noEmit`. `--noEmit` neither builds nor resolves
    // sibling references, so a fresh worktree reds with TS2307 on every
    // `@manta/*` alias. `pnpm typecheck` is the exact command `pnpm gate` runs.
    await execa('pnpm', ['typecheck'], { cwd: worktreePath, timeout: TSC_TIMEOUT_MS });
    return 0;
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string })?.stderr ?? '';
    const stdout = (err as { stdout?: string })?.stdout ?? '';
    const output = stderr + stdout;
    const errorLines = output.split('\n').filter((l) => /\berror TS\d+/.test(l));
    return Math.max(errorLines.length, 1);
  }
}

async function readEslintResults(worktreePath: string): Promise<{ warnings: number; errors: number }> {
  try {
    // bug #63: mirror the canonical lint scope `eslint 'packages/**/src/**/*.ts'`
    // (run via `pnpm exec` to bind the workspace eslint), so the scorer's lint
    // dimension matches what `pnpm gate` measures — not a broader, divergent
    // `eslint .` that scores files the merge bar never gates on.
    const r = await execa(
      'pnpm',
      ['exec', 'eslint', 'packages/**/src/**/*.ts', '--no-error-on-unmatched-pattern', '--format', 'json'],
      {
        cwd: worktreePath,
        timeout: ESLINT_TIMEOUT_MS,
      },
    );
    const results = JSON.parse(r.stdout) as Array<{ warningCount: number; errorCount: number }>;
    let warnings = 0;
    let errors = 0;
    for (const f of results) {
      warnings += f.warningCount;
      errors += f.errorCount;
    }
    return { warnings, errors };
  } catch (err: unknown) {
    const stdout = (err as { stdout?: string })?.stdout ?? '';
    try {
      const results = JSON.parse(stdout) as Array<{ warningCount: number; errorCount: number }>;
      let warnings = 0;
      let errors = 0;
      for (const f of results) {
        warnings += f.warningCount;
        errors += f.errorCount;
      }
      return { warnings, errors };
    } catch {
      return { warnings: 0, errors: 1 };
    }
  }
}

export function createMetricCollector(): MetricCollector {
  return {
    async collect(cloneId: string, worktreePath: string, baseBranch: string): Promise<CollectedMetrics> {
      // bug #63: prepare the worktree (install + build) BEFORE measuring any gate
      // dimension. Without this, tsc/test score missing build artifacts, not real
      // quality, and good committed work is false-negatived.
      await prepareWorktreeForGate(worktreePath);
      const testsPassed = await runTests(worktreePath);
      const [coverageDelta, diffLinesChanged, complexityDelta, tscErrors, eslintResults] =
        await Promise.all([
          readCoverageDelta(worktreePath),
          readDiffSize(worktreePath, baseBranch),
          readComplexityDelta(worktreePath, baseBranch),
          readTscErrors(worktreePath),
          readEslintResults(worktreePath),
        ]);

      return {
        cloneId,
        testsPassed,
        coverageDelta,
        diffLinesChanged,
        complexityDelta,
        tscErrors,
        eslintWarnings: eslintResults.warnings,
        eslintErrors: eslintResults.errors,
        perfDeltaMs: null,
      };
    },
  };
}
