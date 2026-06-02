/**
 * Cast pre-flight diagnostics (#M14 follow-up — "why did my cast crash?").
 *
 * The most confusing failure for an operator (esp. another agent driving Manta)
 * is a cast that won't start or a clone that dies for a reason that reads like a
 * crash but isn't a Manta bug:
 *  - **Orphaned zombie clones** — a previous cast's clone is still `STARTING`/
 *    `WORKING` in the registry but its parent `manta cast` process is gone (the
 *    operator Ctrl-C'd it, the tool-call that launched it timed out, the shell
 *    died). `allocateCloneIds` then refuses with a bare "cannot allocate N
 *    slots" and the operator has no idea those slots are dead, not busy.
 *  - **Stale-but-alive slots** — a genuinely-running concurrent cast (serial-
 *    only rule). Different remedy (wait), same surface.
 *
 * This is a PURE analyzer: given the current registry records + a pid-liveness
 * probe, it classifies the blocking records and returns an actionable verdict.
 * The caller runs it before `allocateCloneIds` and surfaces the message — so the
 * operator gets "2 orphaned clones from a dead cast — run `manta recover`"
 * instead of an opaque allocation error.
 */

export interface PreflightCloneRecord {
  clone_id: string;
  state: string;
  parent_pid: number;
}

export interface CastPreflightVerdict {
  /** Records occupying a slot whose parent process is gone → orphaned zombies. */
  orphaned: PreflightCloneRecord[];
  /** Records occupying a slot whose parent IS alive → a real concurrent cast. */
  liveConcurrent: PreflightCloneRecord[];
  /**
   * A human/agent-actionable line, or null when nothing is blocking. The caller
   * emits this as a warning (orphans → recover) or includes it in the
   * allocation error (live concurrent → wait), so the failure is never opaque.
   */
  message: string | null;
  /** True when the only thing occupying slots is orphaned (safe to recover + retry). */
  recoverable: boolean;
}

/**
 * Analyze the registry before a cast spawns. `pidAlive` is the liveness probe
 * (`makeProbe().alive`); injected so this stays pure + testable.
 */
export function diagnoseCastPreconditions(
  records: PreflightCloneRecord[],
  pidAlive: (pid: number) => boolean,
): CastPreflightVerdict {
  // Only non-DEAD records occupy a clone-letter slot (DEAD slots are reusable).
  const occupying = records.filter((r) => r.state !== 'DEAD');
  const orphaned: PreflightCloneRecord[] = [];
  const liveConcurrent: PreflightCloneRecord[] = [];
  for (const r of occupying) {
    if (pidAlive(r.parent_pid)) liveConcurrent.push(r);
    else orphaned.push(r);
  }

  if (occupying.length === 0) {
    return { orphaned, liveConcurrent, message: null, recoverable: false };
  }

  const ids = (rs: PreflightCloneRecord[]): string => rs.map((r) => r.clone_id).join(', ');

  if (liveConcurrent.length > 0) {
    // A real cast is running. Serial-only: wait or abort it. (Orphans, if any,
    // are secondary here — recover won't free the live ones.)
    const parts = [`a cast is already running (live clones: ${ids(liveConcurrent)})`];
    if (orphaned.length > 0) parts.push(`plus ${orphaned.length} orphaned (${ids(orphaned)})`);
    return {
      orphaned,
      liveConcurrent,
      recoverable: false,
      message:
        `${parts.join('; ')}. Manta runs casts SERIALLY — wait for it to finish, ` +
        `or stop it with \`manta abort\`, before launching another.`,
    };
  }

  // Everything occupying a slot is orphaned: parent process gone, record never
  // settled. This is the "crash I can't explain" case — recover clears it.
  return {
    orphaned,
    liveConcurrent,
    recoverable: true,
    message:
      `${orphaned.length} orphaned clone(s) (${ids(orphaned)}) occupy slots but their ` +
      `parent process is gone — a previous cast was interrupted (Ctrl-C, a timed-out ` +
      `tool call, or a closed shell) before its clones settled. They are NOT running. ` +
      `Run \`manta recover\` to reap them, then re-cast.`,
  };
}
