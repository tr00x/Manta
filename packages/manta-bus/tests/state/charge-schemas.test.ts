import { describe, it, expect } from 'vitest';
import {
  MODE_CHARGE_COST,
  ModeSchema,
  ChargeStateSchema,
  ChargeEventSchema,
  ChargeEventTypeSchema,
  DailySpendEntrySchema,
  DailySpendStateSchema,
  BudgetConfigSchema,
} from '../../src/schema';

describe('MODE_CHARGE_COST', () => {
  it('maps all 10 modes defined in ModeSchema', () => {
    const modes = ModeSchema.options;
    expect(Object.keys(MODE_CHARGE_COST).sort()).toEqual([...modes].sort());
  });

  it('cost-1 modes: recon-swarm, pair-programming, documentation-chase', () => {
    expect(MODE_CHARGE_COST['recon-swarm']).toBe(1);
    expect(MODE_CHARGE_COST['pair-programming']).toBe(1);
    expect(MODE_CHARGE_COST['documentation-chase']).toBe(1);
  });

  it('cost-2 modes: forking-realities, test-storm, refactor-wave, bug-hunt, decoy', () => {
    expect(MODE_CHARGE_COST['forking-realities']).toBe(2);
    expect(MODE_CHARGE_COST['test-storm']).toBe(2);
    expect(MODE_CHARGE_COST['refactor-wave']).toBe(2);
    expect(MODE_CHARGE_COST['bug-hunt']).toBe(2);
    expect(MODE_CHARGE_COST['decoy']).toBe(2);
  });

  it('cost-3 modes: council, phantom-lance', () => {
    expect(MODE_CHARGE_COST['council']).toBe(3);
    expect(MODE_CHARGE_COST['phantom-lance']).toBe(3);
  });

  it('values are all positive integers', () => {
    for (const [, cost] of Object.entries(MODE_CHARGE_COST)) {
      expect(Number.isInteger(cost)).toBe(true);
      expect(cost).toBeGreaterThan(0);
    }
  });
});

describe('ChargeStateSchema', () => {
  const validState = {
    version: 1,
    current_charges: 3,
    charges_max: 5,
    charges_min: -1,
    last_idle_recovery_at: 1700000000000,
    last_cast_ended_at: 0,
    cooldown_until: null,
    total_successes: 0,
    total_failures: 0,
    total_casts: 0,
  };

  it('accepts valid state', () => {
    expect(ChargeStateSchema.parse(validState)).toEqual(validState);
  });

  it('accepts current_charges = -1 (overdraft allowed)', () => {
    const s = { ...validState, current_charges: -1 };
    expect(ChargeStateSchema.parse(s).current_charges).toBe(-1);
  });

  it('rejects current_charges as float', () => {
    expect(() => ChargeStateSchema.parse({ ...validState, current_charges: 2.5 })).toThrow();
  });

  it('rejects extra keys (strict)', () => {
    expect(() => ChargeStateSchema.parse({ ...validState, extra: true })).toThrow();
  });

  it('rejects non-positive charges_max', () => {
    expect(() => ChargeStateSchema.parse({ ...validState, charges_max: 0 })).toThrow();
  });

  it('rejects negative last_idle_recovery_at', () => {
    expect(() => ChargeStateSchema.parse({ ...validState, last_idle_recovery_at: -1 })).toThrow();
  });

  it('accepts cooldown_until as number', () => {
    const s = { ...validState, cooldown_until: 1700086400000 };
    expect(ChargeStateSchema.parse(s).cooldown_until).toBe(1700086400000);
  });
});

describe('ChargeEventTypeSchema', () => {
  const allTypes = [
    'cast_start',
    'cast_success',
    'cast_fail',
    'cast_neutral',
    'idle_recovery',
    'manual_refresh',
    'cooldown_triggered',
    'cooldown_cleared',
  ];

  it('accepts all 8 event types', () => {
    for (const t of allTypes) {
      expect(ChargeEventTypeSchema.parse(t)).toBe(t);
    }
  });

  it('rejects unknown event type', () => {
    expect(() => ChargeEventTypeSchema.parse('unknown_type')).toThrow();
  });
});

describe('ChargeEventSchema', () => {
  const validEvent = {
    ts: 1700000000000,
    type: 'cast_start' as const,
    delta: -2,
    cast_id: 'cast-123',
    mode: 'forking-realities' as const,
    cost: 2,
    prev_charges: 3,
    next_charges: 1,
  };

  it('accepts valid event', () => {
    expect(ChargeEventSchema.parse(validEvent)).toEqual(validEvent);
  });

  it('accepts nullable cast_id (for idle_recovery)', () => {
    const e = {
      ts: 1700000000000,
      type: 'idle_recovery' as const,
      delta: 1,
      cast_id: null,
      mode: null,
      prev_charges: 2,
      next_charges: 3,
    };
    expect(ChargeEventSchema.parse(e).cast_id).toBeNull();
  });

  it('accepts optional reason field', () => {
    const e = { ...validEvent, reason: 'manual refresh by user' };
    expect(ChargeEventSchema.parse(e).reason).toBe('manual refresh by user');
  });

  it('accepts optional cost field', () => {
    const e = { ...validEvent };
    delete (e as Record<string, unknown>).cost;
    expect(ChargeEventSchema.parse(e).cost).toBeUndefined();
  });

  it('rejects extra keys (strict)', () => {
    expect(() => ChargeEventSchema.parse({ ...validEvent, extra: true })).toThrow();
  });

  it('accepts all 8 event types', () => {
    const types = [
      'cast_start', 'cast_success', 'cast_fail', 'cast_neutral',
      'idle_recovery', 'manual_refresh', 'cooldown_triggered', 'cooldown_cleared',
    ];
    for (const type of types) {
      expect(() => ChargeEventSchema.parse({ ...validEvent, type })).not.toThrow();
    }
  });
});

describe('DailySpendEntrySchema', () => {
  const validEntry = {
    cast_id: 'cast-123',
    mode: 'recon-swarm' as const,
    clone_count: 3,
    estimated_cost_usd: 4.5,
    cost_type: 'estimate' as const,
    started_at: 1700000000000,
  };

  it('accepts valid entry', () => {
    expect(DailySpendEntrySchema.parse(validEntry)).toEqual(validEntry);
  });

  it('rejects clone_count <= 0', () => {
    expect(() => DailySpendEntrySchema.parse({ ...validEntry, clone_count: 0 })).toThrow();
  });

  it('rejects negative estimated_cost_usd', () => {
    expect(() => DailySpendEntrySchema.parse({ ...validEntry, estimated_cost_usd: -1 })).toThrow();
  });

  it('accepts cost_type actual', () => {
    const e = { ...validEntry, cost_type: 'actual' as const };
    expect(DailySpendEntrySchema.parse(e).cost_type).toBe('actual');
  });

  it('rejects extra keys (strict)', () => {
    expect(() => DailySpendEntrySchema.parse({ ...validEntry, extra: true })).toThrow();
  });
});

describe('DailySpendStateSchema', () => {
  const validState = {
    version: 1,
    date: '2026-05-26',
    spent_usd: 12.5,
    entries: [],
  };

  it('accepts valid daily state', () => {
    expect(DailySpendStateSchema.parse(validState)).toEqual(validState);
  });

  it('rejects malformed date string', () => {
    expect(() => DailySpendStateSchema.parse({ ...validState, date: '2026/05/26' })).toThrow();
    expect(() => DailySpendStateSchema.parse({ ...validState, date: 'May 26' })).toThrow();
  });

  it('rejects negative spent_usd', () => {
    expect(() => DailySpendStateSchema.parse({ ...validState, spent_usd: -1 })).toThrow();
  });

  it('accepts state with entries', () => {
    const s = {
      ...validState,
      entries: [{
        cast_id: 'cast-1',
        mode: 'recon-swarm',
        clone_count: 2,
        estimated_cost_usd: 3.0,
        cost_type: 'estimate',
        started_at: 1700000000000,
      }],
    };
    expect(DailySpendStateSchema.parse(s).entries).toHaveLength(1);
  });

  it('rejects extra keys (strict)', () => {
    expect(() => DailySpendStateSchema.parse({ ...validState, extra: true })).toThrow();
  });
});

describe('BudgetConfigSchema', () => {
  it('accepts empty object (all fields optional; triggers defaults)', () => {
    // Phase 7c Task 1.2: triggers carries a firing default even on empty input.
    expect(BudgetConfigSchema.parse({})).toEqual({ triggers: { global_hourly_cap: 6 } });
  });

  it('defaults triggers.global_hourly_cap to 6 when no triggers key', () => {
    const parsed = BudgetConfigSchema.parse({ per_cast_usd: 5 });
    expect(parsed.triggers.global_hourly_cap).toBe(6);
  });

  it('accepts an explicit triggers.global_hourly_cap', () => {
    const parsed = BudgetConfigSchema.parse({ triggers: { global_hourly_cap: 2 } });
    expect(parsed.triggers.global_hourly_cap).toBe(2);
  });

  it('rejects triggers.global_hourly_cap: 0 (must be positive)', () => {
    expect(() => BudgetConfigSchema.parse({ triggers: { global_hourly_cap: 0 } })).toThrow();
  });

  it('rejects unknown keys inside triggers (strict)', () => {
    expect(() =>
      BudgetConfigSchema.parse({ triggers: { global_hourly_cap: 6, extra: 1 } }),
    ).toThrow();
  });

  it('accepts per_clone_usd: "auto"', () => {
    const c = { per_clone_usd: 'auto' as const };
    expect(BudgetConfigSchema.parse(c).per_clone_usd).toBe('auto');
  });

  it('accepts per_clone_usd as positive number', () => {
    const c = { per_clone_usd: 5.0 };
    expect(BudgetConfigSchema.parse(c).per_clone_usd).toBe(5.0);
  });

  it('rejects per_clone_usd: 0 (must be positive)', () => {
    expect(() => BudgetConfigSchema.parse({ per_clone_usd: 0 })).toThrow();
  });

  it('rejects negative daily_cap_usd', () => {
    expect(() => BudgetConfigSchema.parse({ daily_cap_usd: -10 })).toThrow();
  });

  it('accepts partial charges sub-object', () => {
    const c = { charges: { initial: 5 } };
    expect(BudgetConfigSchema.parse(c).charges?.initial).toBe(5);
  });

  it('accepts partial auto_downgrade sub-object', () => {
    const c = { auto_downgrade: { enabled: false } };
    expect(BudgetConfigSchema.parse(c).auto_downgrade?.enabled).toBe(false);
  });

  it('accepts full config', () => {
    const full = {
      per_cast_usd: 15,
      per_clone_usd: 5,
      daily_cap_usd: 50,
      cost_estimates: { 'recon-swarm': 1.5, 'forking-realities': 3.0 },
      auto_downgrade: { enabled: true, confirm: true, min_clones: 1 },
      charges: { initial: 3, max: 5, min: -1, idle_recovery_minutes: 30, cooldown_hours: 24 },
    };
    const parsed = BudgetConfigSchema.parse(full);
    expect(parsed.per_cast_usd).toBe(15);
    expect(parsed.charges?.max).toBe(5);
  });

  it('rejects extra keys at top level (strict)', () => {
    expect(() => BudgetConfigSchema.parse({ unknown_field: true })).toThrow();
  });

  it('rejects extra keys in charges sub-object (strict)', () => {
    expect(() => BudgetConfigSchema.parse({ charges: { extra: true } })).toThrow();
  });

  it('rejects extra keys in auto_downgrade sub-object (strict)', () => {
    expect(() => BudgetConfigSchema.parse({ auto_downgrade: { extra: true } })).toThrow();
  });
});
