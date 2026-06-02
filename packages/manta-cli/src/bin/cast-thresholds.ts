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
}

/** Returns the FIX-mode timing defaults, or null for read/quick modes. */
export function fixModeThresholdDefaults(mode: string): FixModeDefaults | null {
  if (!FIX_MODES.has(mode)) return null;
  return {
    heartbeatTimeoutMs: 1_200_000, // 20 min between tool calls
    startupGraceMs: 900_000, // 15 min cold-boot grace
    tickBudgetMs: 3_600_000, // 60 min — must exceed the heartbeat window
  };
}
