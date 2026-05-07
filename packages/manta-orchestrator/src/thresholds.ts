import { z } from 'zod';

export const ThresholdsSchema = z
  .object({
    heartbeatTimeoutMs: z.number().int().positive(),
    staleLockMs: z.number().int().positive(),
    parentPidCheckEnabled: z.boolean(),
    cycleIntervalMs: z.number().int().positive(),
    postMortemDir: z.string().min(1),
  })
  .strict();

export type Thresholds = z.infer<typeof ThresholdsSchema>;

// Defaults sourced from spec:
//  - heartbeatTimeoutMs (30s): Sec 9 blocker #5 — "Suicide через 30 сек после смерти parent"
//    (and a clone that hasn't heartbeated in 30s is presumed dead even with parent alive)
//  - staleLockMs (15s): Sec 4 — locks renew every 5s; 15s = 3 missed renews
//  - cycleIntervalMs (5s): mid-point between 5s lock-renew cadence and 30s heartbeat;
//    catches dead clones within one heartbeat window without thrashing.
//  - parentPidCheckEnabled: spec Sec 9 blocker #5 — must be on by default
export const defaultThresholds: Thresholds = {
  heartbeatTimeoutMs: 30_000,
  staleLockMs: 15_000,
  parentPidCheckEnabled: true,
  cycleIntervalMs: 5_000,
  postMortemDir: 'docs/post-mortems',
};

export function mergeThresholds(override: Partial<Thresholds>): Thresholds {
  return ThresholdsSchema.parse({ ...defaultThresholds, ...override });
}
