import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * RB1/bug #56 — Chunk 2. Fork the main agent's live transcript into a clone's
 * worktree so the clone can `--resume` it (Chunk 3) and boot as a CONTINUATION
 * of the parent conversation, not an empty-context subagent.
 *
 * Mechanism (proven; plan §2): a Claude Code transcript lives on disk at
 * `<claudeHome>/projects/<mangle(cwd)>/<sessionId>.jsonl`. `--resume` is
 * cwd-scoped, so a clone in its own worktree (a DIFFERENT project dir) cannot
 * `--resume <parentId>` directly. The fork is a plain copy of the parent JSONL
 * into the clone's project dir under a fresh uuid; `claude --resume <fork>`
 * then sees a conversation it's allowed to continue. Each clone owns a private
 * fork in its own project dir → no parent race, no inter-clone interference.
 */

/**
 * Map a cwd to Claude Code's on-disk project-dir name. Verified empirically
 * (plan §2.2): every `/` and every `.` becomes `-`. The leading `/.manta`
 * therefore yields a DOUBLE dash (`…manta--manta-worktrees-clone-A`) — the `/`
 * before `.manta` becomes `-` and the `.` becomes `-`. This MUST match Claude
 * Code's real scheme exactly: a mismatch writes the fork where `--resume` will
 * never search → silent empty inheritance no unit test downstream would catch.
 */
export function mangle(cwd: string): string {
  return cwd.replaceAll('/', '-').replaceAll('.', '-');
}

export interface ForkParentSessionArgs {
  /**
   * Real Claude session uuid of the parent. NON-null: the sole caller invokes
   * only when `snap.resumeEnabled`, which the Chunk-1 `.refine` guarantees
   * implies `parentSessionId !== null`. There is intentionally no `no_parent`
   * variant — handling a state that cannot happen would violate the quality bar.
   */
  parentSessionId: string;
  /** Main agent's cwd — where the parent transcript's project dir is derived from. */
  parentCwd: string;
  /** Clone's worktree cwd — where the fork's project dir is derived from. */
  cloneCwd: string;
  /**
   * Claude config home. Injected for hermetic tests; defaults to the
   * empirically-proven `~/.claude` (every live transcript is under
   * `~/.claude/projects/`). We do NOT read `CLAUDE_CONFIG_DIR` or any env for
   * this — `claude --help` exposes no such flag/var, so reading it would ship
   * an unverified guess dressed as fact. Relocatable-home is a deferred
   * follow-up bug only if a real user ever needs it.
   */
  claudeHome?: string;
  /**
   * Skip the fork (and fall back to empty-context behaviour) when the parent
   * JSONL is strictly larger than this. Default 2 MB. Chunk 4 later replaces
   * the `over_threshold` branch with a distilled trim; for now it's a
   * safe-by-default guard so the spine never silently copies an 11.7 MB
   * transcript × N clones.
   */
  thresholdBytes?: number;
}

export type ForkParentSessionResult =
  | { forkedSessionId: string }
  | { skipped: 'not_found' | 'over_threshold' };

const DEFAULT_THRESHOLD_BYTES = 2_000_000;

export async function forkParentSession(
  args: ForkParentSessionArgs,
): Promise<ForkParentSessionResult> {
  const claudeHome = args.claudeHome ?? path.join(os.homedir(), '.claude');
  const thresholdBytes = args.thresholdBytes ?? DEFAULT_THRESHOLD_BYTES;

  const srcPath = path.join(
    claudeHome,
    'projects',
    mangle(args.parentCwd),
    `${args.parentSessionId}.jsonl`,
  );

  let size: number;
  try {
    size = (await fs.stat(srcPath)).size;
  } catch {
    // Parent transcript not on disk (CI, fresh shell, or a stale id). Skip and
    // write nothing — the caller flips resumeEnabled=false + warns.
    return { skipped: 'not_found' };
  }

  if (size > thresholdBytes) {
    // Above the guard: skip without copying (Chunk 4 will distill instead).
    return { skipped: 'over_threshold' };
  }

  const forkedSessionId = randomUUID();
  const destDir = path.join(claudeHome, 'projects', mangle(args.cloneCwd));
  await fs.mkdir(destDir, { recursive: true });
  const destPath = path.join(destDir, `${forkedSessionId}.jsonl`);
  // Plain copy: opens the source exactly once for reading, never mutates it →
  // byte-identical guarantee. `claude` opens only the fork copy thereafter.
  await fs.copyFile(srcPath, destPath);

  return { forkedSessionId };
}
