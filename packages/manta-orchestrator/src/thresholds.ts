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

// Defaults sourced from spec + Phase-2 dogfood (bugs #7 + #8 + Phase 2d):
//  - heartbeatTimeoutMs (300s): Phase 2d dogfood (2026-05-26) proved 90s kills
//    implementation clones. Auto-heartbeat (bug #9 fix) only fires on manta.*
//    MCP calls; Write/Edit/Read are Claude Code built-in tools, not MCP. An
//    implementation clone writing a 200-line file via Write can easily spend
//    120–180s without any manta.* call. Two consecutive casts died at 92s while
//    actively writing replay.test.ts. 300s accommodates the realistic implementation
//    window while still catching genuinely stuck clones within 5 minutes.
//  - startupGraceMs (300s): aligned with heartbeatTimeoutMs. Cold-start claude
//    --print + priming + skill load + snapshot read + initial plan parsing can
//    exceed 90s for implementation tasks with large contracts (1300+ line plans).
//  - staleLockMs (15s): Sec 4 — locks renew every 5s; 15s = 3 missed renews. Locks are
//    held inside tight critical sections, not across reads/edits, so 15s is appropriate.
//  - cycleIntervalMs (5s): catches dead clones within one heartbeat window without thrashing.
//  - parentPidCheckEnabled: spec Sec 9 blocker #5 — must be on by default
export const defaultThresholds: Thresholds = {
  heartbeatTimeoutMs: 300_000,
  startupGraceMs: 300_000,
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
