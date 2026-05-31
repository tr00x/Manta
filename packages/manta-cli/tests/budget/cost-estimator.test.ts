import { describe, it, expect } from 'vitest';
import { estimateCost } from '../../src/budget/cost-estimator.js';
import { BUDGET_DEFAULTS, type ResolvedBudgetConfig } from '../../src/config/budget-config.js';

function makeConfig(overrides: Partial<ResolvedBudgetConfig> = {}): ResolvedBudgetConfig {
  return { ...BUDGET_DEFAULTS, ...overrides };
}

// Units are TOKEN ESTIMATES (usage proxy), not dollars — Claude Code is a
// subscription. The estimator multiplies the per-mode per-clone token estimate
// by clone count and resolves the per-clone token budget.
describe('estimateCost', () => {
  it('recon-swarm × 3 → 150k × 3 = 450k tokens', () => {
    const result = estimateCost('recon-swarm', 3, makeConfig());
    expect(result.mode).toBe('recon-swarm');
    expect(result.cloneCount).toBe(3);
    expect(result.perCloneTokens).toBe(150_000);
    expect(result.totalEstimatedTokens).toBe(450_000);
  });

  it('forking-realities × 2 → 300k × 2 = 600k tokens', () => {
    const result = estimateCost('forking-realities', 2, makeConfig());
    expect(result.mode).toBe('forking-realities');
    expect(result.cloneCount).toBe(2);
    expect(result.perCloneTokens).toBe(300_000);
    expect(result.totalEstimatedTokens).toBe(600_000);
  });

  it('tokenEstimatePerClone: "auto" computes as tokenEstimatePerCast / N', () => {
    const config = makeConfig({ tokenEstimatePerCast: 1_500_000, tokenEstimatePerClone: 'auto' });
    const result = estimateCost('recon-swarm', 3, config);
    expect(result.perCloneTokenBudget).toBe(500_000);
  });

  it('explicit tokenEstimatePerClone numeric override', () => {
    const config = makeConfig({ tokenEstimatePerClone: 80_000 });
    const result = estimateCost('recon-swarm', 3, config);
    expect(result.perCloneTokenBudget).toBe(80_000);
  });

  it('perCloneBudgetOverride takes precedence', () => {
    const config = makeConfig({ tokenEstimatePerClone: 80_000 });
    const result = estimateCost('recon-swarm', 3, config, 120_000);
    expect(result.perCloneTokenBudget).toBe(120_000);
  });

  it('unknown mode in tokenEstimates falls back to 200k/clone', () => {
    const config = makeConfig({
      tokenEstimates: {} as ResolvedBudgetConfig['tokenEstimates'],
    });
    const result = estimateCost('recon-swarm', 2, config);
    expect(result.perCloneTokens).toBe(200_000);
    expect(result.totalEstimatedTokens).toBe(400_000);
  });

  it('single clone', () => {
    const result = estimateCost('council', 1, makeConfig());
    expect(result.perCloneTokens).toBe(500_000);
    expect(result.totalEstimatedTokens).toBe(500_000);
    expect(result.cloneCount).toBe(1);
  });

  it('throws on cloneCount < 1', () => {
    expect(() => estimateCost('recon-swarm', 0, makeConfig())).toThrow('cloneCount must be >= 1');
    expect(() => estimateCost('recon-swarm', -1, makeConfig())).toThrow('cloneCount must be >= 1');
  });
});
