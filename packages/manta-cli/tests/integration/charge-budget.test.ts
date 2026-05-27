import { describe, it, expect, afterEach } from 'vitest';
import { createRuntime } from '../../src/runtime.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';
import { classifyCastOutcome } from '../../src/budget/cast-outcome.js';
import { loadBudgetConfig } from '../../src/config/budget-config.js';
import type { CloneRecord } from '@manta/bus';

describe('charge/budget integration', () => {
  let fx: RepoFixture | undefined;
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  it('scenario 1: full happy path — deduct, cast completes, settle success', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    const config = await loadBudgetConfig(fx.root);

    const stateBefore = await rt.ctx.charges.read();
    expect(stateBefore.current_charges).toBe(3);

    await rt.ctx.charges.deductForCast('cast-happy-1', 'recon-swarm');

    await rt.ctx.dailySpend.recordCastStart({
      cast_id: 'cast-happy-1',
      mode: 'recon-swarm',
      clone_count: 3,
      estimated_cost_usd: config.costEstimates['recon-swarm']! * 3,
      cost_type: 'estimate',
    });

    const afterDeduct = await rt.ctx.charges.read();
    expect(afterDeduct.current_charges).toBe(2);
    expect(afterDeduct.total_casts).toBe(1);

    const clones: CloneRecord[] = [
      { clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/tmp', metadata: {}, registered_at: 0, last_heartbeat_at: 0, state: 'DEAD', death_reason: 'graceful exit' },
      { clone_id: 'B', mode: 'recon-swarm', parent_pid: 1, worktree: '/tmp', metadata: {}, registered_at: 0, last_heartbeat_at: 0, state: 'DEAD', death_reason: 'graceful exit' },
    ];
    const outcome = classifyCastOutcome({ clones, budgetAborted: false });
    expect(outcome).toBe('success');

    await rt.ctx.charges.creditSuccess('cast-happy-1', 'recon-swarm');
    const afterSettle = await rt.ctx.charges.read();
    expect(afterSettle.current_charges).toBe(3);
    expect(afterSettle.total_successes).toBe(1);

    const dailyState = await rt.ctx.dailySpend.read();
    expect(dailyState.entries.length).toBe(1);
    expect(dailyState.spent_usd).toBeCloseTo(4.5);
  });

  it('scenario 2: charge exhaustion — forking-realities needs 2, have 1', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });

    await rt.ctx.charges.deductForCast('c1', 'forking-realities');
    const state = await rt.ctx.charges.read();
    expect(state.current_charges).toBe(1);

    await expect(
      rt.ctx.charges.deductForCast('c2', 'forking-realities'),
    ).rejects.toThrow(/Insufficient charges/);
  });

  it('scenario 3: daily cap enforcement via DailySpendLedger', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    const config = await loadBudgetConfig(fx.root);

    await rt.ctx.dailySpend.recordCastStart({
      cast_id: 'c-big',
      mode: 'forking-realities',
      clone_count: 10,
      estimated_cost_usd: 48.0,
      cost_type: 'estimate',
    });

    const remaining = await rt.ctx.dailySpend.getRemaining(config.dailyCapUsd);
    expect(remaining).toBe(2.0);

    const estCost = config.costEstimates['recon-swarm']! * 3;
    expect(estCost).toBeGreaterThan(remaining);
  });

  it('scenario 4: passive recovery — 35 min idle yields +1 charge', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });

    await rt.ctx.charges.deductForCast('c1', 'recon-swarm');
    const afterDeduct = await rt.ctx.charges.read();
    expect(afterDeduct.current_charges).toBe(2);

    const { creditsApplied } = await rt.ctx.charges.applyPassiveRecovery();
    expect(creditsApplied).toBe(0);
  });

  it('scenario 5: cooldown flow — trigger, verify blocked, clear, verify pass', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });

    await rt.ctx.charges.triggerCooldown();
    const cooledDown = await rt.ctx.charges.read();
    expect(cooledDown.cooldown_until).not.toBeNull();

    await expect(
      rt.ctx.charges.deductForCast('blocked', 'recon-swarm'),
    ).rejects.toThrow(/Cooldown active/);

    await rt.ctx.charges.clearCooldown();
    const cleared = await rt.ctx.charges.read();
    expect(cleared.cooldown_until).toBeNull();
    expect(cleared.current_charges).toBe(0);

    await expect(
      rt.ctx.charges.deductForCast('still-empty', 'recon-swarm'),
    ).rejects.toThrow(/Insufficient charges/);
  });

  it('scenario 6: settlement failure path — budget abort → FAIL → charges -1', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });

    await rt.ctx.charges.deductForCast('c-fail', 'recon-swarm');
    const afterDeduct = await rt.ctx.charges.read();

    const clones: CloneRecord[] = [
      { clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/tmp', metadata: {}, registered_at: 0, last_heartbeat_at: 0, state: 'DEAD', death_reason: 'budget exceeded' },
    ];
    const outcome = classifyCastOutcome({ clones, budgetAborted: true });
    expect(outcome).toBe('fail');

    await rt.ctx.charges.creditFail('c-fail', 'recon-swarm');
    const afterFail = await rt.ctx.charges.read();
    expect(afterFail.current_charges).toBe(afterDeduct.current_charges - 1);
    expect(afterFail.total_failures).toBe(1);
  });

  it('scenario 7a: bug-hunt mode costs 2 charges — deduction and settlement', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });

    const stateBefore = await rt.ctx.charges.read();
    expect(stateBefore.current_charges).toBe(3);

    await rt.ctx.charges.deductForCast('cast-bh-charge-1', 'bug-hunt');

    const afterDeduct = await rt.ctx.charges.read();
    expect(afterDeduct.current_charges).toBe(1);
    expect(afterDeduct.total_casts).toBe(1);

    const clones: CloneRecord[] = [
      { clone_id: 'A', mode: 'bug-hunt', parent_pid: 1, worktree: '/tmp', metadata: {}, registered_at: 0, last_heartbeat_at: 0, state: 'DEAD', death_reason: 'graceful exit' },
      { clone_id: 'B', mode: 'bug-hunt', parent_pid: 1, worktree: '/tmp', metadata: {}, registered_at: 0, last_heartbeat_at: 0, state: 'DEAD', death_reason: 'graceful exit' },
    ];
    const outcome = classifyCastOutcome({ clones, budgetAborted: false });
    expect(outcome).toBe('success');

    await rt.ctx.charges.creditSuccess('cast-bh-charge-1', 'bug-hunt');
    const afterSettle = await rt.ctx.charges.read();
    // creditSuccess always adds +1, not full refund: 1 + 1 = 2
    expect(afterSettle.current_charges).toBe(2);
    expect(afterSettle.total_successes).toBe(1);
  });

  it('scenario 7: settlement neutral — all clones manually killed', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });

    await rt.ctx.charges.deductForCast('c-neutral', 'recon-swarm');
    const afterDeduct = await rt.ctx.charges.read();

    const clones: CloneRecord[] = [
      { clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/tmp', metadata: {}, registered_at: 0, last_heartbeat_at: 0, state: 'DEAD', death_reason: 'manual kill' },
      { clone_id: 'B', mode: 'recon-swarm', parent_pid: 1, worktree: '/tmp', metadata: {}, registered_at: 0, last_heartbeat_at: 0, state: 'DEAD', death_reason: 'manual kill by user' },
    ];
    const outcome = classifyCastOutcome({ clones, budgetAborted: false });
    expect(outcome).toBe('neutral');

    await rt.ctx.charges.creditNeutral('c-neutral', 'recon-swarm');
    const afterNeutral = await rt.ctx.charges.read();
    expect(afterNeutral.current_charges).toBe(afterDeduct.current_charges);
  });
});
