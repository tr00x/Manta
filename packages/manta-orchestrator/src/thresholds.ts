import { z } from 'zod';

export const ThresholdsSchema = z
  .object({
    heartbeatTimeoutMs: z.number().int().positive(),
    startupGraceMs: z.number().int().positive(),
    startupHardCapMs: z.number().int().positive().default(1_800_000),
    staleLockMs: z.number().int().positive(),
    parentPidCheckEnabled: z.boolean(),
    cycleIntervalMs: z.number().int().positive(),
    postMortemDir: z.string().min(1),
    mergeReviewDir: z.string().min(1),
    timelinesDir: z.string().min(1),
    idleHeartbeatTimeoutMs: z.number().int().positive().default(600_000),
    maxIdleTimeMs: z.number().int().positive().default(300_000),
    daemonMaxLifetimeMs: z.number().int().positive().default(3_600_000),
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
//  - startupGraceMs (600s): max gap between cold-boot heartbeats. Measured from
//    last_heartbeat_at, which the spawner's booting-ticker (bug #70) refreshes on
//    a 30s interval WHILE the clone is STARTING — so a live-but-quiet cold boot
//    (large `--resume` transcript replay + MCP handshake before the first tool
//    call) no longer trips it. 600s is a generous missed-tick tolerance.
//  - startupHardCapMs (1800s/30min): absolute ceiling on time-in-STARTING from
//    registration (bug #70). Because the booting-ticker keeps touching a live
//    boot, startupGraceMs alone can't reap a process wedged in STARTING forever;
//    this cap does. Set well above the largest realistic cold boot so a genuine
//    warm-start from a huge transcript still completes, but a hung clone dies.
//  - staleLockMs (15s): Sec 4 — locks renew every 5s; 15s = 3 missed renews. Locks are
//    held inside tight critical sections, not across reads/edits, so 15s is appropriate.
//  - cycleIntervalMs (5s): catches dead clones within one heartbeat window without thrashing.
//  - parentPidCheckEnabled: spec Sec 9 blocker #5 — must be on by default
export const defaultThresholds: Thresholds = {
  heartbeatTimeoutMs: 300_000,
  startupGraceMs: 600_000,
  startupHardCapMs: 1_800_000,
  staleLockMs: 15_000,
  parentPidCheckEnabled: true,
  cycleIntervalMs: 5_000,
  postMortemDir: 'docs/post-mortems',
  mergeReviewDir: 'docs/merge-reviews',
  timelinesDir: '.manta/state/timelines',
  idleHeartbeatTimeoutMs: 600_000,
  maxIdleTimeMs: 300_000,
  daemonMaxLifetimeMs: 3_600_000,
};

export function mergeThresholds(override: Partial<Thresholds>): Thresholds {
  return ThresholdsSchema.parse({ ...defaultThresholds, ...override });
}
