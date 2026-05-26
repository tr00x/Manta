import { execa } from 'execa';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MetricCollector, RawCandidateMetrics } from '@manta/orchestrator';

const TEST_TIMEOUT_MS = 120_000;
const TSC_TIMEOUT_MS = 30_000;
const ESLINT_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 10_000;

type CollectedMetrics = Omit<RawCandidateMetrics, 'selfCertainty'>;

async function runTests(worktreePath: string): Promise<boolean> {
  try {
    await execa('pnpm', ['-r', 'test'], { cwd: worktreePath, timeout: TEST_TIMEOUT_MS });
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
    await execa('npx', ['tsc', '--noEmit'], { cwd: worktreePath, timeout: TSC_TIMEOUT_MS });
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
    const r = await execa('npx', ['eslint', '.', '--format', 'json'], {
      cwd: worktreePath,
      timeout: ESLINT_TIMEOUT_MS,
    });
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
