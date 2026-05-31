import type { ChargeStore, DailySpendLedger, Mode } from '@manta/bus';
import { MODE_CHARGE_COST } from '@manta/bus';
import type { ResolvedBudgetConfig } from '../config/budget-config.js';
import type { Reporter } from '../output/reporter.js';
import { estimateCost, type CostEstimate } from './cost-estimator.js';
import { computeDowngradeOptions, type DowngradeAdvice } from './auto-downgrade.js';

export interface PreSpawnGateOptions {
  mode: Mode;
  cloneCount: number;
  castId: string;
  dailyTokenCapOverride?: number | undefined;
  force: boolean;
  noChargeCheck: boolean;
  dryRun: boolean;
  config: ResolvedBudgetConfig;
  charges: ChargeStore;
  dailySpend: DailySpendLedger;
  reporter: Reporter;
}

export interface PreSpawnGateResult {
  passed: boolean;
  costEstimate: CostEstimate;
  chargesAfterDeduct: number;
  dailySpentAfter: number;
  dailyRemaining: number;
  downgradeAdvice?: DowngradeAdvice;
  committed: boolean;
}

export async function runPreSpawnGate(
  opts: PreSpawnGateOptions,
): Promise<PreSpawnGateResult> {
  const chargeCost = MODE_CHARGE_COST[opts.mode];
  const dailyCap = opts.dailyTokenCapOverride ?? opts.config.dailyTokenCap;
  const costEstimate = estimateCost(opts.mode, opts.cloneCount, opts.config);

  // Step 1: Passive recovery
  if (!opts.noChargeCheck) {
    const { creditsApplied } = await opts.charges.applyPassiveRecovery();
    if (creditsApplied > 0) {
      opts.reporter.info('gate.passive_recovery', { credits: creditsApplied });
    }
  }

  // Step 2: Charge check
  if (!opts.noChargeCheck) {
    const chargeState = await opts.charges.read();

    if (chargeState.cooldown_until != null && Date.now() < chargeState.cooldown_until) {
      opts.reporter.warn('gate.cooldown_active', {
        until: new Date(chargeState.cooldown_until).toISOString(),
      });
      return {
        passed: false,
        costEstimate,
        chargesAfterDeduct: chargeState.current_charges,
        dailySpentAfter: (await opts.dailySpend.read()).tokens_estimated,
        dailyRemaining: await opts.dailySpend.getRemaining(dailyCap),
        committed: false,
      };
    }

    if (chargeState.current_charges < chargeCost) {
      const event = chargeState.current_charges < 0 && chargeCost > 1
        ? 'gate.overdraft_restricted'
        : 'gate.insufficient_charges';
      opts.reporter.warn(event, {
        have: chargeState.current_charges,
        need: chargeCost,
        mode: opts.mode,
      });
      return {
        passed: false,
        costEstimate,
        chargesAfterDeduct: chargeState.current_charges,
        dailySpentAfter: (await opts.dailySpend.read()).tokens_estimated,
        dailyRemaining: await opts.dailySpend.getRemaining(dailyCap),
        committed: false,
      };
    }
  }

  // Step 3: Cost estimation (already done above)
  // Step 4: Per-cast budget check — handled by existing L1/L2 gate in cast.ts
  // before this function is called; not duplicated here.

  // Step 5: Daily cap check
  const dailySpendState = await opts.dailySpend.read();
  const projectedSpend = dailySpendState.tokens_estimated + costEstimate.totalEstimatedTokens;

  if (projectedSpend > dailyCap && !opts.force) {
    const remaining = Math.max(0, dailyCap - dailySpendState.tokens_estimated);
    const downgradeAdvice = computeDowngradeOptions(
      opts.mode,
      opts.cloneCount,
      remaining,
      opts.config,
    );

    opts.reporter.warn('gate.daily_cap_exceeded', {
      projected: projectedSpend,
      cap: dailyCap,
      remaining,
    });

    return {
      passed: false,
      costEstimate,
      chargesAfterDeduct: opts.noChargeCheck ? 0 : (await opts.charges.read()).current_charges,
      dailySpentAfter: dailySpendState.tokens_estimated,
      dailyRemaining: remaining,
      downgradeAdvice,
      committed: false,
    };
  }

  // Step 6: Dry-run output
  if (opts.dryRun) {
    const chargeState = opts.noChargeCheck ? null : await opts.charges.read();
    const remaining = Math.max(0, dailyCap - dailySpendState.tokens_estimated);

    opts.reporter.info('gate.dry_run', {
      mode: opts.mode,
      cloneCount: opts.cloneCount,
      chargeCost,
      estimatedCost: costEstimate.totalEstimatedTokens,
      perCloneCost: costEstimate.perCloneTokens,
      perCloneBudget: costEstimate.perCloneTokenBudget,
      dailyCap,
      dailySpent: dailySpendState.tokens_estimated,
      dailyRemaining: remaining,
      charges: chargeState?.current_charges ?? 'skipped',
      chargesMax: chargeState?.charges_max ?? 'skipped',
    });

    return {
      passed: true,
      costEstimate,
      chargesAfterDeduct: chargeState?.current_charges ?? 0,
      dailySpentAfter: dailySpendState.tokens_estimated,
      dailyRemaining: remaining,
      committed: false,
    };
  }

  // Step 7: Commit deductions
  let chargesAfterDeduct = 0;
  if (!opts.noChargeCheck) {
    const afterState = await opts.charges.deductForCast(opts.castId, opts.mode);
    chargesAfterDeduct = afterState.current_charges;
  }

  const afterDailySpend = await opts.dailySpend.recordCastStart({
    cast_id: opts.castId,
    mode: opts.mode,
    clone_count: opts.cloneCount,
    estimated_tokens: costEstimate.totalEstimatedTokens,
    estimate_type: 'estimate',
  });

  const dailyRemaining = Math.max(0, dailyCap - afterDailySpend.tokens_estimated);

  opts.reporter.info('gate.committed', {
    cast: opts.castId,
    charges: chargesAfterDeduct,
    dailySpent: afterDailySpend.tokens_estimated,
    dailyRemaining,
  });

  return {
    passed: true,
    costEstimate,
    chargesAfterDeduct,
    dailySpentAfter: afterDailySpend.tokens_estimated,
    dailyRemaining,
    committed: true,
  };
}
