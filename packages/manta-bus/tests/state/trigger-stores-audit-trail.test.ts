import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { busPaths } from '../../src/state/paths';
import { EventsLog, type BusEvent } from '../../src/state/events';
import { TriggersArmedStore } from '../../src/state/triggers-armed';
import { TriggerCircuitStore } from '../../src/state/triggers-circuit';
import { FakeClock, type Clock } from '../../src/clock';

// Bug #54 regression — every state-changing mutation on TriggersArmedStore and
// TriggerCircuitStore MUST pair with an events.jsonl append performed INSIDE
// the file mutex (bug #24 audit-trail invariant). Two properties per event:
//   (1) Emission — the named event type lands in events.jsonl on a successful
//       mutation, with a reconstructable payload.
//   (2) Coupling — if the audit append throws, the state file is NOT committed
//       (the append runs before the tmp+rename inside the mutex, so a failed
//       append rolls back the whole mutation). This is what proves the append
//       is INSIDE the mutex, not a fire-and-forget after the write.
//
// Five event types are in scope (the durable trigger transitions):
//   trigger_armed, trigger_disarmed, trigger_circuit_opened,
//   trigger_circuit_reset, trigger_disarmed_by_validation_error.

function tmpRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'manta-audit-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** An EventsLog whose append always throws — used to prove mutex coupling. */
class ThrowingEventsLog extends EventsLog {
  override append(): Promise<BusEvent> {
    return Promise.reject(new Error('audit append boom'));
  }
}

function eventsOf(dir: string, clock: Clock): EventsLog {
  return new EventsLog(busPaths(dir), clock);
}

function armed(dir: string, clock: Clock, events?: EventsLog): TriggersArmedStore {
  return new TriggersArmedStore(busPaths(dir), clock, events ?? eventsOf(dir, clock));
}

function circuit(dir: string, clock: Clock, events?: EventsLog): TriggerCircuitStore {
  return new TriggerCircuitStore(busPaths(dir), clock, events ?? eventsOf(dir, clock));
}

async function typesIn(events: EventsLog): Promise<string[]> {
  return (await events.readAll()).map((e) => e.type);
}

describe('trigger stores audit-trail pairing (bug #54)', () => {
  describe('trigger_armed', () => {
    it('emits trigger_armed on a successful arm, with reconstructable payload', async () => {
      const { dir, cleanup } = tmpRepo();
      try {
        const clock = new FakeClock(5000);
        const ev = eventsOf(dir, clock);
        const s = armed(dir, clock, ev);
        await s.setPendingDryRun('t-a');
        await s.arm('t-a', { dryRunEstimateTokens: 2.5 });
        const all = await ev.readAll();
        const armedEvents = all.filter((e) => e.type === 'trigger_armed');
        expect(armedEvents).toHaveLength(1);
        const payload = armedEvents[0]!.payload as Record<string, unknown>;
        expect(payload.name).toBe('t-a');
        expect(payload.armed_at).toBe(5000);
        expect(payload.dry_run_estimate_tokens).toBe(2.5);
      } finally {
        cleanup();
      }
    });

    it('rolls back arm when the audit append throws (append is INSIDE the mutex)', async () => {
      const { dir, cleanup } = tmpRepo();
      try {
        const clock = new FakeClock(5000);
        // Set up pending state with a working events log.
        await armed(dir, clock, eventsOf(dir, clock)).setPendingDryRun('t-a');
        // Arm with a throwing events log — must reject and leave state untouched.
        const broken = armed(dir, clock, new ThrowingEventsLog(busPaths(dir), clock));
        await expect(broken.arm('t-a', { dryRunEstimateTokens: 2.5 })).rejects.toThrow('boom');
        // State must NOT have advanced to armed.
        expect(await armed(dir, clock, eventsOf(dir, clock)).getState('t-a')).toBe('pending_dry_run');
      } finally {
        cleanup();
      }
    });
  });

  describe('trigger_disarmed', () => {
    it('emits trigger_disarmed on disarm of an armed trigger', async () => {
      const { dir, cleanup } = tmpRepo();
      try {
        const clock = new FakeClock(1000);
        const ev = eventsOf(dir, clock);
        const s = armed(dir, clock, ev);
        await s.setPendingDryRun('t-d');
        await s.arm('t-d', { dryRunEstimateTokens: 1 });
        await s.disarm('t-d');
        const disarmed = (await ev.readAll()).filter((e) => e.type === 'trigger_disarmed');
        expect(disarmed).toHaveLength(1);
        expect((disarmed[0]!.payload as Record<string, unknown>).name).toBe('t-d');
      } finally {
        cleanup();
      }
    });

    it('disarmAll emits a single trigger_disarmed carrying the flipped names', async () => {
      const { dir, cleanup } = tmpRepo();
      try {
        const clock = new FakeClock(1000);
        const ev = eventsOf(dir, clock);
        const s = armed(dir, clock, ev);
        await s.setPendingDryRun('t-1');
        await s.arm('t-1', { dryRunEstimateTokens: 1 });
        await s.setPendingDryRun('t-2');
        const flipped = await s.disarmAll();
        expect(new Set(flipped)).toEqual(new Set(['t-1', 't-2']));
        const disarmed = (await ev.readAll()).filter((e) => e.type === 'trigger_disarmed');
        // exactly one aggregate event for the panic flip
        expect(disarmed).toHaveLength(1);
        const payload = disarmed[0]!.payload as Record<string, unknown>;
        expect(new Set(payload.names as string[])).toEqual(new Set(['t-1', 't-2']));
        expect(payload.reason).toBe('disarm_all');
      } finally {
        cleanup();
      }
    });

    it('rolls back disarm when the audit append throws', async () => {
      const { dir, cleanup } = tmpRepo();
      try {
        const clock = new FakeClock(1000);
        const setup = armed(dir, clock, eventsOf(dir, clock));
        await setup.setPendingDryRun('t-d');
        await setup.arm('t-d', { dryRunEstimateTokens: 1 });
        const broken = armed(dir, clock, new ThrowingEventsLog(busPaths(dir), clock));
        await expect(broken.disarm('t-d')).rejects.toThrow('boom');
        expect(await armed(dir, clock, eventsOf(dir, clock)).getState('t-d')).toBe('armed');
      } finally {
        cleanup();
      }
    });
  });

  describe('trigger_disarmed_by_validation_error', () => {
    it('emits trigger_disarmed_by_validation_error only on the disarming (3rd) error', async () => {
      const { dir, cleanup } = tmpRepo();
      try {
        const clock = new FakeClock(1000);
        const ev = eventsOf(dir, clock);
        const s = armed(dir, clock, ev);
        await s.setPendingDryRun('t-v');
        await s.arm('t-v', { dryRunEstimateTokens: 1 });
        expect((await s.recordValidationError('t-v')).disarmed).toBe(false);
        expect((await s.recordValidationError('t-v')).disarmed).toBe(false);
        // No disarm-by-validation event yet (only counter increments).
        expect((await typesIn(ev)).filter((t) => t === 'trigger_disarmed_by_validation_error')).toHaveLength(0);
        expect((await s.recordValidationError('t-v')).disarmed).toBe(true);
        const events = (await ev.readAll()).filter((e) => e.type === 'trigger_disarmed_by_validation_error');
        expect(events).toHaveLength(1);
        const payload = events[0]!.payload as Record<string, unknown>;
        expect(payload.name).toBe('t-v');
        expect(payload.consecutive_validation_errors).toBe(3);
      } finally {
        cleanup();
      }
    });

    it('rolls back the disarming validation error when the audit append throws', async () => {
      const { dir, cleanup } = tmpRepo();
      try {
        const clock = new FakeClock(1000);
        const setup = armed(dir, clock, eventsOf(dir, clock));
        await setup.setPendingDryRun('t-v');
        await setup.arm('t-v', { dryRunEstimateTokens: 1 });
        await setup.recordValidationError('t-v');
        await setup.recordValidationError('t-v');
        const broken = armed(dir, clock, new ThrowingEventsLog(busPaths(dir), clock));
        await expect(broken.recordValidationError('t-v')).rejects.toThrow('boom');
        // Still armed — the disarming mutation rolled back with its event.
        expect(await armed(dir, clock, eventsOf(dir, clock)).getState('t-v')).toBe('armed');
      } finally {
        cleanup();
      }
    });
  });

  describe('trigger_circuit_opened', () => {
    it('emits trigger_circuit_opened only on the trip (budget-refusal burst)', async () => {
      const { dir, cleanup } = tmpRepo();
      try {
        const clock = new FakeClock(0);
        const ev = eventsOf(dir, clock);
        const s = circuit(dir, clock, ev);
        await s.recordBudgetRefusal('ta');
        await s.recordBudgetRefusal('tb');
        expect((await typesIn(ev)).filter((t) => t === 'trigger_circuit_opened')).toHaveLength(0);
        const res = await s.recordBudgetRefusal('tc');
        expect(res.tripped).toBe(true);
        const opened = (await ev.readAll()).filter((e) => e.type === 'trigger_circuit_opened');
        expect(opened).toHaveLength(1);
        expect((opened[0]!.payload as Record<string, unknown>).reason).toContain('budget-refusal burst');
      } finally {
        cleanup();
      }
    });

    it('emits trigger_circuit_opened on a depth-breach trip', async () => {
      const { dir, cleanup } = tmpRepo();
      try {
        const clock = new FakeClock(0);
        const ev = eventsOf(dir, clock);
        const s = circuit(dir, clock, ev);
        await s.recordDepthBreach('head-x');
        const res = await s.recordDepthBreach('head-x');
        expect(res.tripped).toBe(true);
        const opened = (await ev.readAll()).filter((e) => e.type === 'trigger_circuit_opened');
        expect(opened).toHaveLength(1);
      } finally {
        cleanup();
      }
    });

    it('rolls back the trip when the audit append throws', async () => {
      const { dir, cleanup } = tmpRepo();
      try {
        const clock = new FakeClock(0);
        const setup = circuit(dir, clock, eventsOf(dir, clock));
        await setup.recordBudgetRefusal('ta');
        await setup.recordBudgetRefusal('tb');
        const broken = circuit(dir, clock, new ThrowingEventsLog(busPaths(dir), clock));
        await expect(broken.recordBudgetRefusal('tc')).rejects.toThrow('boom');
        // Trip rolled back — breaker still closed.
        expect(await circuit(dir, clock, eventsOf(dir, clock)).isOpen()).toBe(false);
      } finally {
        cleanup();
      }
    });
  });

  describe('trigger_circuit_reset', () => {
    it('emits trigger_circuit_reset carrying the operator reason', async () => {
      const { dir, cleanup } = tmpRepo();
      try {
        const clock = new FakeClock(0);
        const ev = eventsOf(dir, clock);
        const s = circuit(dir, clock, ev);
        await s.recordBudgetRefusal('ta');
        await s.recordBudgetRefusal('tb');
        await s.recordBudgetRefusal('tc'); // trip
        await s.reset('manual circuit-reset by operator');
        const reset = (await ev.readAll()).filter((e) => e.type === 'trigger_circuit_reset');
        expect(reset).toHaveLength(1);
        expect((reset[0]!.payload as Record<string, unknown>).reason).toBe('manual circuit-reset by operator');
        expect(await s.isOpen()).toBe(false);
      } finally {
        cleanup();
      }
    });

    it('rolls back the reset when the audit append throws', async () => {
      const { dir, cleanup } = tmpRepo();
      try {
        const clock = new FakeClock(0);
        const setup = circuit(dir, clock, eventsOf(dir, clock));
        await setup.recordBudgetRefusal('ta');
        await setup.recordBudgetRefusal('tb');
        await setup.recordBudgetRefusal('tc'); // trip → open
        const broken = circuit(dir, clock, new ThrowingEventsLog(busPaths(dir), clock));
        await expect(broken.reset('boom-reset')).rejects.toThrow('boom');
        // Reset rolled back — breaker still open.
        expect(await circuit(dir, clock, eventsOf(dir, clock)).isOpen()).toBe(true);
      } finally {
        cleanup();
      }
    });
  });
});
