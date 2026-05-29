import { z } from 'zod';
import { atomicMutateJson, atomicReadJson } from '../atomic-fs';
import type { Clock } from '../clock';
import { TriggerNameSchema } from '../trigger-schema';
import type { EventsLog } from './events';
import type { BusPaths } from './paths';

// Phase 7c Task 1.5 — armed.json is the SOLE source of truth for whether a
// trigger may spawn. Even if a YAML's `enabled` were somehow true, this
// bus-side state wins, so editing the YAML can never silently re-arm. The
// three-state machine (disarmed → pending_dry_run → armed) is enforced HERE,
// in the store, not in skill text.

export const TriggerArmedStateSchema = z.enum(['disarmed', 'pending_dry_run', 'armed']);
export type TriggerArmedState = z.infer<typeof TriggerArmedStateSchema>;

const ArmedEntrySchema = z
  .object({
    state: TriggerArmedStateSchema,
    armed_at: z.number().int().nonnegative().nullable(),
    armed_by_dry_run_ok: z.boolean(),
    dry_run_estimate_usd: z.number().nonnegative().nullable(),
    // §3.9 — disarm after 3 consecutive validation errors.
    consecutive_validation_errors: z.number().int().nonnegative().default(0),
  })
  .strict();

const ArmedFileSchema = z
  .object({
    version: z.literal(1),
    triggers: z.record(TriggerNameSchema, ArmedEntrySchema),
  })
  .strict();

export type ArmedFile = z.infer<typeof ArmedFileSchema>;
type ArmedEntry = z.infer<typeof ArmedEntrySchema>;

export type TriggerStateErrorCode = 'illegal_transition';

export class TriggerStateError extends Error {
  readonly code: TriggerStateErrorCode;
  constructor(code: TriggerStateErrorCode, message: string) {
    super(message);
    this.name = 'TriggerStateError';
    this.code = code;
  }
}

const VALIDATION_ERROR_DISARM_THRESHOLD = 3;

function emptyFile(): ArmedFile {
  return { version: 1, triggers: {} };
}

function disarmedEntry(): ArmedEntry {
  return {
    state: 'disarmed',
    armed_at: null,
    armed_by_dry_run_ok: false,
    dry_run_estimate_usd: null,
    consecutive_validation_errors: 0,
  };
}

export class TriggersArmedStore {
  // Bug #54: `events` is a REQUIRED dependency, not optional. Every armed-state
  // transition that matters for forensic reconstruction (arm / disarm /
  // disarm-all panic / validation-error disarm) MUST pair with an events.jsonl
  // append performed INSIDE the file mutex (the bug #24 audit-trail invariant).
  // Making the dependency required means no construction site can silently skip
  // the audit trail — the gap that produced bug #54 in the first place.
  constructor(
    private readonly paths: BusPaths,
    private readonly clock: Clock,
    private readonly events: EventsLog,
  ) {}

  async read(): Promise<ArmedFile> {
    const raw = await atomicReadJson<ArmedFile>(this.paths.triggersArmed, emptyFile);
    return ArmedFileSchema.parse(raw);
  }

  async getState(name: string): Promise<TriggerArmedState> {
    const file = await this.read();
    return file.triggers[name]?.state ?? 'disarmed';
  }

  async setPendingDryRun(name: string): Promise<void> {
    await this.mutate((file) => {
      const entry = file.triggers[name] ?? disarmedEntry();
      file.triggers[name] = {
        ...entry,
        state: 'pending_dry_run',
        armed_at: null,
        armed_by_dry_run_ok: false,
      };
      return file;
    });
  }

  /** Requires current state pending_dry_run; throws illegal_transition otherwise. */
  async arm(name: string, opts: { dryRunEstimateUsd: number }): Promise<void> {
    const now = this.clock.now();
    await this.mutate(
      (file) => {
        const current = file.triggers[name]?.state ?? 'disarmed';
        if (current !== 'pending_dry_run') {
          throw new TriggerStateError(
            'illegal_transition',
            `cannot arm trigger '${name}' from state '${current}' (must be pending_dry_run; run --dry-fire first)`,
          );
        }
        file.triggers[name] = {
          ...(file.triggers[name] ?? disarmedEntry()),
          state: 'armed',
          armed_at: now,
          armed_by_dry_run_ok: true,
          dry_run_estimate_usd: opts.dryRunEstimateUsd,
          consecutive_validation_errors: 0,
        };
        return file;
      },
      // Bug #54: pair the arm transition with its audit event inside the mutex.
      () =>
        this.appendEvent('trigger_armed', {
          name,
          armed_at: now,
          dry_run_estimate_usd: opts.dryRunEstimateUsd,
        }),
    );
  }

  /** Idempotent; never throws (panic button must always succeed). */
  async disarm(name: string): Promise<void> {
    await this.mutate(
      (file) => {
        const entry = file.triggers[name];
        file.triggers[name] = {
          ...(entry ?? disarmedEntry()),
          state: 'disarmed',
          armed_at: null,
          armed_by_dry_run_ok: false,
        };
        return file;
      },
      // Only fires when atomicMutateJson detects an actual state change (the
      // already-disarmed idempotent case is a no-op write → no event).
      () => this.appendEvent('trigger_disarmed', { name }),
    );
  }

  /** Flips every armed/pending trigger to disarmed; returns flipped names. Never throws. */
  async disarmAll(): Promise<string[]> {
    const flipped: string[] = [];
    await this.mutate(
      (file) => {
        for (const [name, entry] of Object.entries(file.triggers)) {
          if (entry.state !== 'disarmed') {
            flipped.push(name);
            file.triggers[name] = { ...entry, state: 'disarmed', armed_at: null, armed_by_dry_run_ok: false };
          }
        }
        return file;
      },
      // One aggregate audit event for the panic flip, carrying every flipped
      // name so the timeline can reconstruct exactly what the panic touched.
      // Only fires when at least one trigger actually flipped (changed write).
      () => this.appendEvent('trigger_disarmed', { names: flipped, reason: 'disarm_all' }),
    );
    return flipped;
  }

  /** Records a validation error; disarms at 3 consecutive. */
  async recordValidationError(name: string): Promise<{ disarmed: boolean }> {
    let disarmed = false;
    let count = 0;
    await this.mutate(
      (file) => {
        const entry = file.triggers[name] ?? disarmedEntry();
        count = entry.consecutive_validation_errors + 1;
        if (count >= VALIDATION_ERROR_DISARM_THRESHOLD) {
          disarmed = true;
          file.triggers[name] = {
            ...entry,
            state: 'disarmed',
            armed_at: null,
            armed_by_dry_run_ok: false,
            consecutive_validation_errors: count,
          };
        } else {
          file.triggers[name] = { ...entry, consecutive_validation_errors: count };
        }
        return file;
      },
      // Counter increments are transient bookkeeping; only the DISARMING error
      // is an audit-worthy state transition. The closure runs after the mutator
      // (inside the mutex) so `disarmed` is already decided when it fires.
      async () => {
        if (disarmed) {
          await this.appendEvent('trigger_disarmed_by_validation_error', {
            name,
            consecutive_validation_errors: count,
          });
        }
      },
    );
    return { disarmed };
  }

  async clearValidationErrors(name: string): Promise<void> {
    await this.mutate((file) => {
      const entry = file.triggers[name];
      if (entry) {
        file.triggers[name] = { ...entry, consecutive_validation_errors: 0 };
      }
      return file;
    });
  }

  /**
   * Bug #54: append an audit event to events.jsonl. Invoked from within the
   * armed.json file mutex (as atomicMutateJson's `auditAppend`), BEFORE the
   * tmp+rename commit — so if the append throws, the state mutation rolls back
   * and the events.jsonl entry never appears either. `clone_id` is omitted:
   * triggers are repo-scoped, not clone-scoped.
   */
  private async appendEvent(type: string, payload: Record<string, unknown>): Promise<void> {
    await this.events.append({ type, payload });
  }

  private async mutate(
    mutator: (file: ArmedFile) => ArmedFile,
    auditAppend?: () => Promise<void>,
  ): Promise<ArmedFile> {
    return atomicMutateJson<ArmedFile>(
      this.paths.triggersArmed,
      emptyFile,
      (current) => {
        const parsed = ArmedFileSchema.parse(current);
        return mutator(parsed);
      },
      auditAppend,
    );
  }
}
