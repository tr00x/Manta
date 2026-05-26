import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { adjustWeightsFromProject } from '../../src/commands/rubric-prepass.js';
import { DEFAULT_SCORING_CONFIG } from '@manta/orchestrator';

describe('rubric pre-pass', () => {
  let tmpDir: string | undefined;
  afterEach(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('no config files → no adjustments', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-rubric-empty-'));
    const { config, adjustments } = await adjustWeightsFromProject(tmpDir, DEFAULT_SCORING_CONFIG);
    expect(adjustments).toHaveLength(0);
    expect(config).toEqual(DEFAULT_SCORING_CONFIG);
  });

  it('strict tsconfig → typeCheck bumped by +0.05', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-rubric-strict-'));
    await fs.writeFile(
      path.join(tmpDir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true } }),
    );
    const { config, adjustments } = await adjustWeightsFromProject(tmpDir, DEFAULT_SCORING_CONFIG);
    expect(adjustments.length).toBeGreaterThan(0);
    expect(adjustments.find((a) => a.axis === 'typeCheck')?.reason).toContain('strict');
    const sum = Object.values(config.weights).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 5);
  });

  it('strict + noUncheckedIndexedAccess → typeCheck bumped by +0.10', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-rubric-strict2-'));
    await fs.writeFile(
      path.join(tmpDir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true, noUncheckedIndexedAccess: true } }),
    );
    const { adjustments } = await adjustWeightsFromProject(tmpDir, DEFAULT_SCORING_CONFIG);
    const typeCheckAdj = adjustments.find((a) => a.axis === 'typeCheck');
    expect(typeCheckAdj).toBeDefined();
    expect(typeCheckAdj!.newWeight - typeCheckAdj!.oldWeight).toBeCloseTo(0.10, 5);
  });

  it('weight normalization preserves sum = 1.00', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-rubric-norm-'));
    await fs.writeFile(
      path.join(tmpDir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true, noUncheckedIndexedAccess: true } }),
    );
    const { config } = await adjustWeightsFromProject(tmpDir, DEFAULT_SCORING_CONFIG);
    const sum = Object.values(config.weights).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 5);
  });
});
