import { z } from 'zod';

export const ThresholdsSchema = z
  .object({
    heartbeatTimeoutMs: z.number().int().positive(),
    startupGraceMs: z.number().int().positive(),
    staleLockMs: z.number().int().positive(),
    parentPidCheckEnabled: z.boolean(),
    cycleIntervalMs: z.number().int().positive(),
    postMortemDir: z.string().min(1),
    mergeReviewDir: z.string().min(1),
    timelinesDir: z.string().min(1),
  })
  .strict();

export type Thresholds = z.infer<typeof ThresholdsSchema>;

// Defaults sourced from spec + Phase-2 dogfood (bugs #7 + #8):
//  - heartbeatTimeoutMs (90s): applies to clones in WORKING state. The skill says
//    "heartbeat every ≤ 10s" but Claude doesn't track wallclock between tool calls;
//    a clone reading a 5KB spec + thinking + writing markdown can go 30–60s between
//    heartbeats while doing legitimate work. The original 30s threshold killed
//    productive clones (bug #8, Phase-2 dogfood cast-1778187134719: all 3 clones
//    sent exactly one heartbeat, then died at +32s while still doing real research).
//    90s matches startupGraceMs for symmetry and covers the realistic working window.
//  - startupGraceMs (90s): applies to clones in STARTING state (registered by spawner,
//    no real heartbeat yet). Cold-start `claude --print` + priming + skill load +
//    snapshot read can exceed 30s for the first MCP call (bug #7, Phase-2 dogfood).
//    Clones that don't reach first heartbeat by 90s are genuinely stuck.
//  - staleLockMs (15s): Sec 4 — locks renew every 5s; 15s = 3 missed renews. Locks are
//    held inside tight critical sections, not across reads/edits, so 15s is appropriate.
//  - cycleIntervalMs (5s): catches dead clones within one heartbeat window without thrashing.
//  - parentPidCheckEnabled: spec Sec 9 blocker #5 — must be on by default
export const defaultThresholds: Thresholds = {
  heartbeatTimeoutMs: 90_000,
  startupGraceMs: 90_000,
  staleLockMs: 15_000,
  parentPidCheckEnabled: true,
  cycleIntervalMs: 5_000,
  postMortemDir: 'docs/post-mortems',
  mergeReviewDir: 'docs/merge-reviews',
  timelinesDir: '.manta/state/timelines',
};

export function mergeThresholds(override: Partial<Thresholds>): Thresholds {
  return ThresholdsSchema.parse({ ...defaultThresholds, ...override });
}
