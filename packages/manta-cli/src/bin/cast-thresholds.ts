/**
 * #M12: FIX modes do long coding stretches + run a test suite, so a single op
 * can exceed the 300s default heartbeatTimeoutMs and the reaper silently kills
 * an actively-working clone (empty branch, no report). Give those modes a
 * roomier DEFAULT; read/quick modes (recon-swarm, documentation-chase, council,
 * decoy, forking-realities's scoring) keep the tight default — they don't have
 * long silent generation gaps. An EXPLICIT operator flag always wins over these.
 *
 * Lives in its own module (not bin/manta.ts) so it is unit-testable without
 * importing the bin, which runs `main()` on load.
 */
export const FIX_MODES: ReadonlySet<string> = new Set([
  'refactor-wave',
  'bug-hunt',
  'pair-programming',
  'test-storm',
]);

export interface FixModeDefaults {
  heartbeatTimeoutMs: number;
  startupGraceMs: number;
  tickBudgetMs: number;
  idleHeartbeatTimeoutMs: number;
  maxIdleTimeMs: number;
}

/** Returns the FIX-mode timing defaults, or null for read/quick modes. */
export function fixModeThresholdDefaults(mode: string): FixModeDefaults | null {
  if (!FIX_MODES.has(mode)) return null;
  return {
    heartbeatTimeoutMs: 1_200_000, // 20 min between tool calls
    startupGraceMs: 900_000, // 15 min cold-boot grace
    tickBudgetMs: 3_600_000, // 60 min — must exceed the heartbeat window
    // #M11: pair-programming / test-storm are DAEMON modes — a clone (e.g. the
    // reviewer) legitimately goes IDLE/WAITING_FOR_TASK between turns, waiting
    // for the resume-loop to push the next work item once its partner finishes.
    // A partner's turn can take a full heartbeatTimeoutMs (20 min), so the idle
    // reapers must tolerate at least that long or a correctly-waiting daemon is
    // reaped mid-cast (the #M11 recurrence: reviewer reaped at the 600s idle-
    // heartbeat default while the writer was still working). Give daemon idle
    // states the same generous envelope as the active-work timeout, with margin.
    idleHeartbeatTimeoutMs: 1_800_000, // 30 min — survive a full partner turn + margin
    maxIdleTimeMs: 1_800_000, // 30 min — ditto for the idle-duration reaper
  };
}

export interface ThresholdUndercutWarning {
  flag: string;
  given: number;
  fixModeDefault: number;
  mode: string;
  hint: string;
}

export interface ExplicitTimingFlags {
  heartbeatTimeoutMs?: number | undefined;
  startupGraceMs?: number | undefined;
  forceFullTranscript?: boolean | undefined;
}

/**
 * #M13: an explicit `--startup-grace-ms` / `--heartbeat-timeout-ms` BELOW the
 * FIX-mode safe default silently defeats the protection built for exactly the
 * long-warm-boot case — a `--startup-grace-ms 600000` on a long
 * `--force-full-transcript` FIX cast lowered the grace under the 900s default
 * and a 602s warm-boot replay got reaped "no first heartbeat". The override
 * still wins (the operator may know better), but it must not be silent. Returns
 * a warning per undercut flag; empty for non-FIX modes or values at/above the
 * default. Pure (no I/O) so it's unit-testable; the caller emits each warning.
 */
export function thresholdUndercutWarnings(
  mode: string,
  flags: ExplicitTimingFlags,
): ThresholdUndercutWarning[] {
  const fix = fixModeThresholdDefaults(mode);
  if (!fix) return [];
  const out: ThresholdUndercutWarning[] = [];
  if (flags.heartbeatTimeoutMs !== undefined && flags.heartbeatTimeoutMs < fix.heartbeatTimeoutMs) {
    out.push({
      flag: '--heartbeat-timeout-ms',
      given: flags.heartbeatTimeoutMs,
      fixModeDefault: fix.heartbeatTimeoutMs,
      mode,
      hint: `${mode} is a FIX mode whose default heartbeat timeout is ${fix.heartbeatTimeoutMs}ms; your explicit ${flags.heartbeatTimeoutMs}ms is LOWER and may reap a clone mid-work. Raise it (or omit the flag) unless you mean to tighten it.`,
    });
  }
  if (flags.startupGraceMs !== undefined && flags.startupGraceMs < fix.startupGraceMs) {
    const warmNote = flags.forceFullTranscript
      ? ' On a long --force-full-transcript session the warm-boot replay can exceed it and the clone is reaped "no first heartbeat" (#M13).'
      : '';
    out.push({
      flag: '--startup-grace-ms',
      given: flags.startupGraceMs,
      fixModeDefault: fix.startupGraceMs,
      mode,
      hint: `${mode} is a FIX mode whose default startup grace is ${fix.startupGraceMs}ms; your explicit ${flags.startupGraceMs}ms is LOWER.${warmNote} Raise it (1200000+) or omit the flag.`,
    });
  }
  return out;
}
