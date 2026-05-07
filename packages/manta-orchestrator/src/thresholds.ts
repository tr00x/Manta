import { z } from 'zod';

export const ThresholdsSchema = z
  .object({
    heartbeatTimeoutMs: z.number().int().positive(),
    startupGraceMs: z.number().int().positive(),
    staleLockMs: z.number().int().positive(),
    parentPidCheckEnabled: z.boolean(),
    cycleIntervalMs: z.number().int().positive(),
    postMortemDir: z.string().min(1),
  })
  .strict();

export type Thresholds = z.infer<typeof ThresholdsSchema>;

// Defaults sourced from spec + bug #7 dogfood:
//  - heartbeatTimeoutMs (30s): applies to clones in WORKING state. After a real heartbeat
//    moves state STARTING → WORKING, 30s without renewal = stale = DEAD.
//  - startupGraceMs (90s): applies to clones in STARTING state (registered by spawner,
//    no real heartbeat yet). Cold-start `claude --print` + priming + skill load + snapshot
//    read can exceed 30s for the first MCP call (bug #7, Phase-2 dogfood). 90s gives
//    headroom; clones that don't reach first heartbeat by then are genuinely stuck.
//  - staleLockMs (15s): Sec 4 — locks renew every 5s; 15s = 3 missed renews
//  - cycleIntervalMs (5s): mid-point between 5s lock-renew cadence and 30s heartbeat;
//    catches dead clones within one heartbeat window without thrashing.
//  - parentPidCheckEnabled: spec Sec 9 blocker #5 — must be on by default
export const defaultThresholds: Thresholds = {
  heartbeatTimeoutMs: 30_000,
  startupGraceMs: 90_000,
  staleLockMs: 15_000,
  parentPidCheckEnabled: true,
  cycleIntervalMs: 5_000,
  postMortemDir: 'docs/post-mortems',
};

export function mergeThresholds(override: Partial<Thresholds>): Thresholds {
  return ThresholdsSchema.parse({ ...defaultThresholds, ...override });
}
