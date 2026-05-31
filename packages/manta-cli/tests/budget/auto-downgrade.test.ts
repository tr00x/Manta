import { describe, it, expect } from 'vitest';
import { computeDowngradeOptions } from '../../src/budget/auto-downgrade.js';
import { BUDGET_DEFAULTS, type ResolvedBudgetConfig } from '../../src/config/budget-config.js';

// Units throughout are TOKEN ESTIMATES (subscription usage proxy), NOT dollars —
// Claude Code is a subscription, not pay-per-token (budget repivot 2026-05-31).
// Per-clone defaults: forking-realities = 300k, recon-swarm = 150k.
function makeConfig(overrides: Partial<ResolvedBudgetConfig> = {}): ResolvedBudgetConfig {
  return { ...BUDGET_DEFAULTS, ...overrides };
}

describe('computeDowngradeOptions', () => {
  it('3 clones forking-realities, 600k remaining → suggests 2 clones (600k ✓)', () => {
    const advice = computeDowngradeOptions('forking-realities', 3, 600_000, makeConfig());
    expect(advice.originalEstimate.totalEstimatedTokens).toBe(900_000);
    expect(advice.remainingTokenBudget).toBe(600_000);
    const twoClone = advice.options.find((o) => o.mode === 'forking-realities' && o.cloneCount === 2);
    expect(twoClone).toBeDefined();
    expect(twoClone!.viable).toBe(true);
    expect(twoClone!.estimatedTokens).toBe(600_000);
  });

  it('3 clones forking-realities, 400k remaining → 1 forking clone (300k ✓) + recon-swarm 2 clones (300k ✓)', () => {
    const advice = computeDowngradeOptions('forking-realities', 3, 400_000, makeConfig());
    const oneClone = advice.options.find((o) => o.mode === 'forking-realities' && o.cloneCount === 1);
    expect(oneClone).toBeDefined();
    expect(oneClone!.viable).toBe(true);
    expect(oneClone!.estimatedTokens).toBe(300_000);

    const reconSwarm3 = advice.options.find((o) => o.mode === 'recon-swarm' && o.cloneCount === 3);
    expect(reconSwarm3).toBeDefined();
    expect(reconSwarm3!.viable).toBe(false);

    const reconSwarm2 = advice.options.find((o) => o.mode === 'recon-swarm' && o.cloneCount === 2);
    expect(reconSwarm2).toBeDefined();
    expect(reconSwarm2!.viable).toBe(true);
    expect(reconSwarm2!.estimatedTokens).toBe(300_000);
  });

  it('1 clone, 0 remaining → no viable options', () => {
    const advice = computeDowngradeOptions('recon-swarm', 1, 0, makeConfig());
    const viable = advice.options.filter((o) => o.viable);
    expect(viable.length).toBe(0);
  });

  it('minClones=2 → won\'t suggest below 2', () => {
    const config = makeConfig({
      autoDowngrade: { enabled: true, confirm: true, minClones: 2 },
    });
    const advice = computeDowngradeOptions('forking-realities', 3, 400_000, config);
    const belowMin = advice.options.filter(
      (o) => o.mode === 'forking-realities' && o.cloneCount < 2,
    );
    expect(belowMin.length).toBe(0);
  });

  it('auto_downgrade.enabled=false → returns empty options', () => {
    const config = makeConfig({
      autoDowngrade: { enabled: false, confirm: true, minClones: 1 },
    });
    const advice = computeDowngradeOptions('forking-realities', 3, 400_000, config);
    expect(advice.options.length).toBe(0);
  });

  it('recon-swarm is already cheapest — no cheaper mode suggested', () => {
    const advice = computeDowngradeOptions('recon-swarm', 3, 200_000, makeConfig());
    const cheaperMode = advice.options.filter((o) => o.mode !== 'recon-swarm');
    expect(cheaperMode.length).toBe(0);
  });

  it('originalEstimate matches cost estimate', () => {
    const advice = computeDowngradeOptions('forking-realities', 2, 1_000_000, makeConfig());
    expect(advice.originalEstimate.mode).toBe('forking-realities');
    expect(advice.originalEstimate.cloneCount).toBe(2);
    expect(advice.originalEstimate.totalEstimatedTokens).toBe(600_000);
  });
});
