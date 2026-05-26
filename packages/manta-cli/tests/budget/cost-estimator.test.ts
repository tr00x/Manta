import { describe, it, expect } from 'vitest';
import { estimateCost } from '../../src/budget/cost-estimator';
import { BUDGET_DEFAULTS, type ResolvedBudgetConfig } from '../../src/config/budget-config';

function makeConfig(overrides: Partial<ResolvedBudgetConfig> = {}): ResolvedBudgetConfig {
  return { ...BUDGET_DEFAULTS, ...overrides };
}

describe('estimateCost', () => {
  it('recon-swarm × 3 → $1.50 × 3 = $4.50', () => {
    const result = estimateCost('recon-swarm', 3, makeConfig());
    expect(result.mode).toBe('recon-swarm');
    expect(result.cloneCount).toBe(3);
    expect(result.perCloneCostUsd).toBe(1.50);
    expect(result.totalEstimatedUsd).toBe(4.50);
  });

  it('forking-realities × 2 → $3.00 × 2 = $6.00', () => {
    const result = estimateCost('forking-realities', 2, makeConfig());
    expect(result.mode).toBe('forking-realities');
    expect(result.cloneCount).toBe(2);
    expect(result.perCloneCostUsd).toBe(3.00);
    expect(result.totalEstimatedUsd).toBe(6.00);
  });

  it('perCloneUsd: "auto" computes as perCastUsd / N', () => {
    const config = makeConfig({ perCastUsd: 15, perCloneUsd: 'auto' });
    const result = estimateCost('recon-swarm', 3, config);
    expect(result.perCloneBudgetUsd).toBe(5);
  });

  it('explicit perCloneUsd numeric override', () => {
    const config = makeConfig({ perCloneUsd: 8 });
    const result = estimateCost('recon-swarm', 3, config);
    expect(result.perCloneBudgetUsd).toBe(8);
  });

  it('perCloneBudgetOverride takes precedence', () => {
    const config = makeConfig({ perCloneUsd: 8 });
    const result = estimateCost('recon-swarm', 3, config, 12);
    expect(result.perCloneBudgetUsd).toBe(12);
  });

  it('unknown mode in costEstimates falls back to $2.00/clone', () => {
    const config = makeConfig({
      costEstimates: {} as ResolvedBudgetConfig['costEstimates'],
    });
    const result = estimateCost('recon-swarm', 2, config);
    expect(result.perCloneCostUsd).toBe(2.00);
    expect(result.totalEstimatedUsd).toBe(4.00);
  });

  it('single clone', () => {
    const result = estimateCost('council', 1, makeConfig());
    expect(result.perCloneCostUsd).toBe(5.00);
    expect(result.totalEstimatedUsd).toBe(5.00);
    expect(result.cloneCount).toBe(1);
  });

  it('throws on cloneCount < 1', () => {
    expect(() => estimateCost('recon-swarm', 0, makeConfig())).toThrow('cloneCount must be >= 1');
    expect(() => estimateCost('recon-swarm', -1, makeConfig())).toThrow('cloneCount must be >= 1');
  });
});
