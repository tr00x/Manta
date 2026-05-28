import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ScoringConfig } from '@manta/orchestrator';
import type { WeightAdjustment } from '@manta/orchestrator';

interface RubricResult {
  config: ScoringConfig;
  adjustments: WeightAdjustment[];
}

export async function adjustWeightsFromProject(
  repoRoot: string,
  baseConfig: ScoringConfig,
): Promise<RubricResult> {
  const adjustments: WeightAdjustment[] = [];
  const weights = { ...baseConfig.weights };

  await applyTsconfigAdjustments(repoRoot, weights, adjustments);
  await applyEslintAdjustments(repoRoot, weights, adjustments);
  await applyVitestAdjustments(repoRoot, weights, adjustments);

  if (adjustments.length > 0) {
    normalizeWeights(weights);
  }

  return {
    config: { ...baseConfig, weights },
    adjustments,
  };
}

async function applyTsconfigAdjustments(
  repoRoot: string,
  weights: Record<string, number>,
  adjustments: WeightAdjustment[],
): Promise<void> {
  try {
    const raw = await readFile(join(repoRoot, 'tsconfig.json'), 'utf-8');
    const tsconfig = JSON.parse(raw) as {
      compilerOptions?: { strict?: boolean; noUncheckedIndexedAccess?: boolean };
    };
    const co = tsconfig.compilerOptions;
    if (!co?.strict) return;

    if (co.noUncheckedIndexedAccess) {
      const oldTypeCheck = weights.typeCheck!;
      const oldDiff = weights.diff!;
      weights.typeCheck = oldTypeCheck + 0.10;
      weights.diff = oldDiff - 0.10;
      adjustments.push(
        { axis: 'typeCheck', oldWeight: oldTypeCheck, newWeight: weights.typeCheck, reason: 'tsconfig strict + noUncheckedIndexedAccess' },
        { axis: 'diff', oldWeight: oldDiff, newWeight: weights.diff, reason: 'tsconfig strict + noUncheckedIndexedAccess (balance)' },
      );
    } else {
      const oldTypeCheck = weights.typeCheck!;
      const oldDiff = weights.diff!;
      weights.typeCheck = oldTypeCheck + 0.05;
      weights.diff = oldDiff - 0.05;
      adjustments.push(
        { axis: 'typeCheck', oldWeight: oldTypeCheck, newWeight: weights.typeCheck, reason: 'tsconfig strict mode' },
        { axis: 'diff', oldWeight: oldDiff, newWeight: weights.diff, reason: 'tsconfig strict mode (balance)' },
      );
    }
  } catch {
    // no tsconfig — no adjustment
  }
}

async function applyEslintAdjustments(
  repoRoot: string,
  weights: Record<string, number>,
  adjustments: WeightAdjustment[],
): Promise<void> {
  const candidates = [
    '.eslintrc.json',
    '.eslintrc.js',
    '.eslintrc.cjs',
    '.eslintrc.yml',
    '.eslintrc.yaml',
    'eslint.config.js',
    'eslint.config.mjs',
    'eslint.config.cjs',
    'eslint.config.ts',
  ];
  for (const name of candidates) {
    try {
      const raw = await readFile(join(repoRoot, name), 'utf-8');
      const rulePattern = /["'][\w/@-]+["']\s*:\s*["'[]/g;
      const matches = raw.match(rulePattern);
      if (matches && matches.length > 100) {
        const oldLint = weights.lint!;
        const oldComplexity = weights.complexity!;
        weights.lint = oldLint + 0.05;
        weights.complexity = oldComplexity - 0.05;
        adjustments.push(
          { axis: 'lint', oldWeight: oldLint, newWeight: weights.lint, reason: `strict eslint config (${matches.length} rules in ${name})` },
          { axis: 'complexity', oldWeight: oldComplexity, newWeight: weights.complexity, reason: `strict eslint config (balance)` },
        );
      }
      return;
    } catch {
      // try next candidate
    }
  }
}

async function applyVitestAdjustments(
  repoRoot: string,
  weights: Record<string, number>,
  adjustments: WeightAdjustment[],
): Promise<void> {
  const candidates = ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mts'];
  for (const name of candidates) {
    try {
      const raw = await readFile(join(repoRoot, name), 'utf-8');
      const thresholdMatch = raw.match(/thresholds?\s*[:{]/);
      const highThreshold = raw.match(/(?:lines|branches|functions|statements)\s*:\s*(\d+)/);
      if (thresholdMatch && highThreshold) {
        const val = parseInt(highThreshold[1]!, 10);
        if (val >= 90) {
          const oldCoverage = weights.coverage!;
          const oldDiff = weights.diff!;
          weights.coverage = oldCoverage + 0.05;
          weights.diff = oldDiff - 0.05;
          adjustments.push(
            { axis: 'coverage', oldWeight: oldCoverage, newWeight: weights.coverage, reason: `vitest coverage threshold ≥ ${val}%` },
            { axis: 'diff', oldWeight: oldDiff, newWeight: weights.diff, reason: `vitest coverage threshold (balance)` },
          );
        }
      }
      return;
    } catch {
      // try next candidate
    }
  }
}

function normalizeWeights(weights: Record<string, number>): void {
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  if (sum === 0) return;
  for (const key of Object.keys(weights)) {
    weights[key] = weights[key]! / sum;
  }
}
