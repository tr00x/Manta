import { describe, it, expect } from 'vitest';
import { computeDowngradeOptions } from '../../src/budget/auto-downgrade';
import { BUDGET_DEFAULTS, type ResolvedBudgetConfig } from '../../src/config/budget-config';

function makeConfig(overrides: Partial<ResolvedBudgetConfig> = {}): ResolvedBudgetConfig {
  return { ...BUDGET_DEFAULTS, ...overrides };
}

describe('computeDowngradeOptions', () => {
  it('3 clones forking-realities, $6 remaining → suggests 2 clones ($6.00 ✓)', () => {
    const advice = computeDowngradeOptions('forking-realities', 3, 6, makeConfig());
    expect(advice.originalEstimate.totalEstimatedUsd).toBe(9.00);
    expect(advice.remainingBudgetUsd).toBe(6);
    const twoClone = advice.options.find((o) => o.mode === 'forking-realities' && o.cloneCount === 2);
    expect(twoClone).toBeDefined();
    expect(twoClone!.viable).toBe(true);
    expect(twoClone!.estimatedCostUsd).toBe(6.00);
  });

  it('3 clones forking-realities, $4 remaining → suggests 1 clone ($3.00 ✓) + recon-swarm 2 clones ($3.00 ✓)', () => {
    const advice = computeDowngradeOptions('forking-realities', 3, 4, makeConfig());
    const oneClone = advice.options.find((o) => o.mode === 'forking-realities' && o.cloneCount === 1);
    expect(oneClone).toBeDefined();
    expect(oneClone!.viable).toBe(true);
    expect(oneClone!.estimatedCostUsd).toBe(3.00);

    const reconSwarm3 = advice.options.find((o) => o.mode === 'recon-swarm' && o.cloneCount === 3);
    expect(reconSwarm3).toBeDefined();
    expect(reconSwarm3!.viable).toBe(false);

    const reconSwarm2 = advice.options.find((o) => o.mode === 'recon-swarm' && o.cloneCount === 2);
    expect(reconSwarm2).toBeDefined();
    expect(reconSwarm2!.viable).toBe(true);
    expect(reconSwarm2!.estimatedCostUsd).toBe(3.00);
  });

  it('1 clone, $0 remaining → no viable options', () => {
    const advice = computeDowngradeOptions('recon-swarm', 1, 0, makeConfig());
    const viable = advice.options.filter((o) => o.viable);
    expect(viable.length).toBe(0);
  });

  it('minClones=2 → won\'t suggest below 2', () => {
    const config = makeConfig({
      autoDowngrade: { enabled: true, confirm: true, minClones: 2 },
    });
    const advice = computeDowngradeOptions('forking-realities', 3, 4, config);
    const belowMin = advice.options.filter(
      (o) => o.mode === 'forking-realities' && o.cloneCount < 2,
    );
    expect(belowMin.length).toBe(0);
  });

  it('auto_downgrade.enabled=false → returns empty options', () => {
    const config = makeConfig({
      autoDowngrade: { enabled: false, confirm: true, minClones: 1 },
    });
    const advice = computeDowngradeOptions('forking-realities', 3, 4, config);
    expect(advice.options.length).toBe(0);
  });

  it('recon-swarm is already cheapest — no cheaper mode suggested', () => {
    const advice = computeDowngradeOptions('recon-swarm', 3, 2, makeConfig());
    const cheaperMode = advice.options.filter((o) => o.mode !== 'recon-swarm');
    expect(cheaperMode.length).toBe(0);
  });

  it('originalEstimate matches cost estimate', () => {
    const advice = computeDowngradeOptions('forking-realities', 2, 10, makeConfig());
    expect(advice.originalEstimate.mode).toBe('forking-realities');
    expect(advice.originalEstimate.cloneCount).toBe(2);
    expect(advice.originalEstimate.totalEstimatedUsd).toBe(6.00);
  });
});
