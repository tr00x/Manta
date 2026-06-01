import { execa } from 'execa';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MetricCollector, RawCandidateMetrics } from '@manta/orchestrator';
import { detectToolchain, type Toolchain } from './toolchain.js';

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
  const tc = detectToolchain(worktreePath);
  await runSerialized(async () => {
    // Bug #M9: install/build are toolchain-specific (pnpm for Manta's own repo;
    // npm/pip/cargo/go elsewhere; null = nothing to do). bug #63 reasoning still
    // holds for the pnpm path: a fresh worktree has no node_modules/dist, so the
    // @manta/* aliases must be installed + built BEFORE measuring tsc/test or
    // good work false-REDs. Errors are swallowed (reject:false): a worktree that
    // genuinely can't install/build surfaces as a downstream test/tsc RED — the
    // correct true-RED — instead of throwing here.
    if (tc.install) {
      await execa(tc.install[0], [...tc.install.slice(1)], {
        cwd: worktreePath,
        timeout: INSTALL_TIMEOUT_MS,
        reject: false,
      });
    }
    if (tc.build) {
      await execa(tc.build[0], [...tc.build.slice(1)], {
        cwd: worktreePath,
        timeout: BUILD_TIMEOUT_MS,
        reject: false,
      });
    }
  });
}

interface TestOutcome {
  /** A test gate was applicable and was executed. */
  ran: boolean;
  /** Tests passed. Only meaningful when `ran` is true. */
  passed: boolean;
}

async function runTests(worktreePath: string, tc: Toolchain): Promise<TestOutcome> {
  // Bug #M9: no detectable test command (unrecognised toolchain, or an npm
  // project with no `test` script) → the gate is SKIPPED, not failed. Returning
  // ran:false keeps the candidate in scoring instead of silently DQ-ing it on
  // test_gate (the old `pnpm test` hardcode DQ'd every non-JS candidate).
  if (!tc.test) return { ran: false, passed: false };
  try {
    await execa(tc.test[0], [...tc.test.slice(1)], { cwd: worktreePath, timeout: TEST_TIMEOUT_MS });
    return { ran: true, passed: true };
  } catch {
    return { ran: true, passed: false };
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

/**
 * Did this execa error because the binary doesn't exist (ENOENT / "command not
 * found")? Bug #M9: a tool that isn't installed must SKIP its quality axis
 * (neutral), never penalise the candidate. This distinguishes "tool absent"
 * from "tool ran and found errors".
 */
function isMissingToolError(err: unknown): boolean {
  const e = err as { code?: string; shortMessage?: string; message?: string };
  if (e?.code === 'ENOENT') return true;
  const msg = `${e?.shortMessage ?? ''} ${e?.message ?? ''}`;
  return /ENOENT|command not found|not found/i.test(msg);
}

function countEslintFromJson(raw: string): { warnings: number; errors: number } {
  const results = JSON.parse(raw) as Array<{ warningCount: number; errorCount: number }>;
  let warnings = 0;
  let errors = 0;
  for (const f of results) {
    warnings += f.warningCount;
    errors += f.errorCount;
  }
  return { warnings, errors };
}

/**
 * Bug #M9: run the toolchain's typecheck command and count errors via the
 * declared parser. Toolchain-agnostic — `tsc` (count `error TSxxxx` lines),
 * `cargo check` / `go build` (exit-code: 0 errors on success, 1 on failure).
 * Null command (axis not applicable) or a missing tool → 0 (neutral skip).
 * bug #63 reasoning for the pnpm path is preserved (typecheck = `tsc -b` via
 * `pnpm typecheck`, run after install+build so sibling refs resolve).
 */
async function readTypecheckErrors(worktreePath: string, tc: Toolchain): Promise<number> {
  if (!tc.typecheck) return 0;
  try {
    await execa(tc.typecheck[0], [...tc.typecheck.slice(1)], {
      cwd: worktreePath,
      timeout: TSC_TIMEOUT_MS,
    });
    return 0;
  } catch (err: unknown) {
    if (isMissingToolError(err)) return 0; // tool absent → skip, don't penalise
    if (tc.typecheckParser === 'tsc') {
      const stderr = (err as { stderr?: string })?.stderr ?? '';
      const stdout = (err as { stdout?: string })?.stdout ?? '';
      const errorLines = (stderr + stdout).split('\n').filter((l) => /\berror TS\d+/.test(l));
      return Math.max(errorLines.length, 1);
    }
    // exit-code parser: a non-zero exit means the compile/type gate failed.
    return 1;
  }
}

/**
 * Bug #M9: run the toolchain's lint command and count warnings/errors via the
 * declared parser. eslint-json parses the JSON report; exit-code (go vet, …)
 * maps a non-zero exit to one error. Null command or a missing tool → neutral.
 */
async function readLintResults(
  worktreePath: string,
  tc: Toolchain,
): Promise<{ warnings: number; errors: number }> {
  if (!tc.lint) return { warnings: 0, errors: 0 };
  try {
    const r = await execa(tc.lint[0], [...tc.lint.slice(1)], {
      cwd: worktreePath,
      timeout: ESLINT_TIMEOUT_MS,
    });
    if (tc.lintParser === 'eslint-json') return countEslintFromJson(r.stdout);
    return { warnings: 0, errors: 0 }; // exit-code parser, exit 0 = clean
  } catch (err: unknown) {
    if (isMissingToolError(err)) return { warnings: 0, errors: 0 }; // tool absent → skip
    if (tc.lintParser === 'eslint-json') {
      // eslint exits non-zero when it finds errors but still prints JSON on stdout.
      const stdout = (err as { stdout?: string })?.stdout ?? '';
      try {
        return countEslintFromJson(stdout);
      } catch {
        return { warnings: 0, errors: 1 };
      }
    }
    // exit-code parser (go vet, …): non-zero = a real lint failure.
    return { warnings: 0, errors: 1 };
  }
}

export function createMetricCollector(): MetricCollector {
  return {
    async collect(cloneId: string, worktreePath: string, baseBranch: string): Promise<CollectedMetrics> {
      // Bug #M9: detect the worktree's toolchain once and drive every gate step
      // from it. bug #63: prepare (install + build) BEFORE measuring, so a fresh
      // worktree doesn't false-RED on missing build artifacts.
      const tc = detectToolchain(worktreePath);
      await prepareWorktreeForGate(worktreePath);
      const test = await runTests(worktreePath, tc);
      // Bug #M9: every quality axis is toolchain-driven now — typecheck is `tsc`
      // for JS/TS, `cargo check` for Rust, `go build` for Go; lint is eslint for
      // JS/TS, `go vet` for Go. An axis the toolchain marks null (e.g. lint for
      // Python/Rust) — or whose tool isn't installed — scores neutral (0), so a
      // non-JS candidate is judged on the axes that apply to it (test + coverage
      // + diff + complexity), never penalised for not being TypeScript.
      const [coverageDelta, diffLinesChanged, complexityDelta, tscErrors, eslintResults] =
        await Promise.all([
          readCoverageDelta(worktreePath),
          readDiffSize(worktreePath, baseBranch),
          readComplexityDelta(worktreePath, baseBranch),
          readTypecheckErrors(worktreePath, tc),
          readLintResults(worktreePath, tc),
        ]);

      return {
        cloneId,
        testsPassed: test.passed,
        testsRan: test.ran,
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
