import { atomicMutateJson, atomicReadJson, appendJsonLine } from '../atomic-fs';
import type { Clock } from '../clock';
import type { ChargeState, ChargeEvent, Mode } from '../schema';
import { ChargeStateSchema, ChargeEventSchema, MODE_CHARGE_COST } from '../schema';
import { BusConflictError } from '../errors';
import type { BusPaths } from './paths';

export interface ChargeStoreConfig {
  initial: number;
  max: number;
  min: number;
  idleRecoveryMinutes: number;
  cooldownHours: number;
}

export const DEFAULT_CHARGE_CONFIG: ChargeStoreConfig = {
  initial: 3,
  max: 5,
  min: -1,
  idleRecoveryMinutes: 30,
  cooldownHours: 24,
};

export class ChargeStore {
  constructor(
    private readonly paths: BusPaths,
    private readonly clock: Clock,
    private readonly config: ChargeStoreConfig = DEFAULT_CHARGE_CONFIG,
  ) {}

  async read(): Promise<ChargeState> {
    return atomicReadJson<ChargeState>(this.paths.charges, () => this.defaultState());
  }

  async deductForCast(castId: string, mode: Mode): Promise<ChargeState> {
    const cost = MODE_CHARGE_COST[mode];
    let prevCharges = 0;
    let nextCharges = 0;

    const result = await atomicMutateJson<ChargeState>(
      this.paths.charges,
      () => this.defaultState(),
      (current) => {
        if (current.cooldown_until != null && this.clock.now() < current.cooldown_until) {
          throw new BusConflictError(
            `Cooldown active until ${new Date(current.cooldown_until).toISOString()}. ` +
            `Use /manta refresh to clear.`,
          );
        }
        if (current.current_charges < cost) {
          throw new BusConflictError(
            `Insufficient charges: have ${current.current_charges}, need ${cost} for ${mode}. ` +
            `Wait for idle recovery or /manta refresh.`,
          );
        }
        if (current.current_charges < 0 && cost > 1) {
          throw new BusConflictError(
            `In overdraft (${current.current_charges}): only cost-1 modes allowed. ` +
            `${mode} costs ${cost}.`,
          );
        }
        prevCharges = current.current_charges;
        nextCharges = current.current_charges - cost;
        return {
          ...current,
          current_charges: nextCharges,
          total_casts: current.total_casts + 1,
        };
      },
      async () => {
        const event: ChargeEvent = {
          ts: this.clock.now(),
          type: 'cast_start',
          delta: -cost,
          cast_id: castId,
          mode,
          cost,
          prev_charges: prevCharges,
          next_charges: nextCharges,
        };
        ChargeEventSchema.parse(event);
        await appendJsonLine(this.paths.chargesLog, event);
      },
    );
    return result;
  }

  async creditSuccess(castId: string, mode: Mode): Promise<ChargeState> {
    let prevCharges = 0;
    let nextCharges = 0;

    const result = await atomicMutateJson<ChargeState>(
      this.paths.charges,
      () => this.defaultState(),
      (current) => {
        prevCharges = current.current_charges;
        nextCharges = Math.min(current.current_charges + 1, current.charges_max);
        return {
          ...current,
          current_charges: nextCharges,
          total_successes: current.total_successes + 1,
          last_cast_ended_at: this.clock.now(),
        };
      },
      async () => {
        const event: ChargeEvent = {
          ts: this.clock.now(),
          type: 'cast_success',
          delta: nextCharges - prevCharges,
          cast_id: castId,
          mode,
          prev_charges: prevCharges,
          next_charges: nextCharges,
        };
        ChargeEventSchema.parse(event);
        await appendJsonLine(this.paths.chargesLog, event);
      },
    );
    return result;
  }

  async creditFail(castId: string, mode: Mode): Promise<ChargeState> {
    let prevCharges = 0;
    let nextCharges = 0;
    let shouldCooldown = false;

    const result = await atomicMutateJson<ChargeState>(
      this.paths.charges,
      () => this.defaultState(),
      (current) => {
        prevCharges = current.current_charges;
        nextCharges = current.current_charges - 1;
        shouldCooldown = nextCharges < current.charges_min;
        return {
          ...current,
          current_charges: nextCharges,
          total_failures: current.total_failures + 1,
          last_cast_ended_at: this.clock.now(),
        };
      },
      async () => {
        const event: ChargeEvent = {
          ts: this.clock.now(),
          type: 'cast_fail',
          delta: -1,
          cast_id: castId,
          mode,
          prev_charges: prevCharges,
          next_charges: nextCharges,
        };
        ChargeEventSchema.parse(event);
        await appendJsonLine(this.paths.chargesLog, event);
      },
    );

    if (shouldCooldown) {
      return this.triggerCooldown();
    }
    return result;
  }

  async creditNeutral(castId: string, mode: Mode): Promise<ChargeState> {
    let currentCharges = 0;

    const result = await atomicMutateJson<ChargeState>(
      this.paths.charges,
      () => this.defaultState(),
      (current) => {
        currentCharges = current.current_charges;
        return {
          ...current,
          last_cast_ended_at: this.clock.now(),
        };
      },
      async () => {
        const event: ChargeEvent = {
          ts: this.clock.now(),
          type: 'cast_neutral',
          delta: 0,
          cast_id: castId,
          mode,
          prev_charges: currentCharges,
          next_charges: currentCharges,
        };
        ChargeEventSchema.parse(event);
        await appendJsonLine(this.paths.chargesLog, event);
      },
    );
    return result;
  }

  async applyPassiveRecovery(): Promise<{ creditsApplied: number; state: ChargeState }> {
    const recoveryMs = this.config.idleRecoveryMinutes * 60_000;
    let creditsApplied = 0;
    let prevCharges = 0;

    const state = await atomicMutateJson<ChargeState>(
      this.paths.charges,
      () => this.defaultState(),
      (current) => {
        prevCharges = current.current_charges;
        const baseline = Math.max(current.last_idle_recovery_at, current.last_cast_ended_at);
        const elapsed = this.clock.now() - baseline;
        const slots = Math.floor(elapsed / recoveryMs);

        if (slots <= 0 || current.current_charges >= current.charges_max) {
          return current;
        }

        const maxCredits = current.charges_max - current.current_charges;
        creditsApplied = Math.min(slots, maxCredits);

        return {
          ...current,
          current_charges: current.current_charges + creditsApplied,
          last_idle_recovery_at: baseline + creditsApplied * recoveryMs,
        };
      },
      async () => {
        if (creditsApplied > 0) {
          const event: ChargeEvent = {
            ts: this.clock.now(),
            type: 'idle_recovery',
            delta: creditsApplied,
            cast_id: null,
            mode: null,
            prev_charges: prevCharges,
            next_charges: prevCharges + creditsApplied,
          };
          ChargeEventSchema.parse(event);
          await appendJsonLine(this.paths.chargesLog, event);
        }
      },
    );
    return { creditsApplied, state };
  }

  async triggerCooldown(): Promise<ChargeState> {
    const cooldownMs = this.config.cooldownHours * 3600_000;
    let prevCharges = 0;
    let nextCharges = 0;

    const result = await atomicMutateJson<ChargeState>(
      this.paths.charges,
      () => this.defaultState(),
      (current) => {
        prevCharges = current.current_charges;
        nextCharges = current.current_charges;
        return {
          ...current,
          cooldown_until: this.clock.now() + cooldownMs,
        };
      },
      async () => {
        const event: ChargeEvent = {
          ts: this.clock.now(),
          type: 'cooldown_triggered',
          delta: 0,
          cast_id: null,
          mode: null,
          prev_charges: prevCharges,
          next_charges: nextCharges,
          reason: `Charges below min (${prevCharges}). Cooldown for ${this.config.cooldownHours}h.`,
        };
        ChargeEventSchema.parse(event);
        await appendJsonLine(this.paths.chargesLog, event);
      },
    );
    return result;
  }

  async clearCooldown(): Promise<ChargeState> {
    let prevCharges = 0;

    const result = await atomicMutateJson<ChargeState>(
      this.paths.charges,
      () => this.defaultState(),
      (current) => {
        prevCharges = current.current_charges;
        return {
          ...current,
          cooldown_until: null,
          current_charges: 0,
        };
      },
      async () => {
        const event: ChargeEvent = {
          ts: this.clock.now(),
          type: 'cooldown_cleared',
          delta: 0 - prevCharges,
          cast_id: null,
          mode: null,
          prev_charges: prevCharges,
          next_charges: 0,
          reason: 'Manual refresh via /manta refresh',
        };
        ChargeEventSchema.parse(event);
        await appendJsonLine(this.paths.chargesLog, event);
      },
    );
    return result;
  }

  async reset(): Promise<ChargeState> {
    const state = this.defaultState();
    const result = await atomicMutateJson<ChargeState>(
      this.paths.charges,
      () => state,
      () => state,
    );
    return result;
  }

  async readLog(): Promise<ChargeEvent[]> {
    const { readFile } = await import('node:fs/promises');
    let raw: string;
    try {
      raw = await readFile(this.paths.chargesLog, 'utf8');
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT') {
        return [];
      }
      throw err;
    }
    if (!raw.trim()) return [];
    const events: ChargeEvent[] = [];
    for (const line of raw.trim().split('\n')) {
      try {
        events.push(ChargeEventSchema.parse(JSON.parse(line)));
      } catch {
        // Skip malformed lines (crash recovery tolerance)
      }
    }
    return events;
  }

  private defaultState(): ChargeState {
    return {
      version: 1,
      current_charges: this.config.initial,
      charges_max: this.config.max,
      charges_min: this.config.min,
      last_idle_recovery_at: this.clock.now(),
      last_cast_ended_at: 0,
      cooldown_until: null,
      total_successes: 0,
      total_failures: 0,
      total_casts: 0,
    };
  }
}
