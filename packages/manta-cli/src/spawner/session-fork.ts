import * as fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
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
 * (probe 2026-05-29, bug #61): Claude Code (a) resolves the symlink-real path
 * of the cwd, then (b) replaces EVERY non-alphanumeric character with `-`
 * (case preserved; consecutive separators are NOT collapsed, so a leading
 * `/.manta` still yields the `…manta--manta-worktrees-clone-A` double dash).
 * Two real-world cases the old `/`+`.`-only transform got wrong — each writing
 * the fork where `--resume` never searches → silent empty inheritance (the
 * exact #56 failure mode, invisible to every downstream unit test):
 *   - symlinked bases: on macOS `/var` and `/tmp` are symlinks to `/private/*`,
 *     so `claude` mangles `/private/var/…`, not the logical `/var/…`.
 *   - `_` / space / `+` / `@` / …: any repo path with an underscore
 *     (e.g. `/Users/me/my_app`) mangled to a dir name `claude` never uses.
 * `realpathSync` requires the path to exist; in production the parent repo root
 * and the clone worktree both exist at fork time (cast.ts creates the worktree
 * before calling forkParentSession). The catch-fallback to the literal path is
 * ONLY for not-yet-created paths in unit fixtures (no symlink there, so logical
 * == real); it must never be hit in production or the silent-inheritance bug
 * returns.
 */
export function mangle(cwd: string): string {
  let resolved: string;
  try {
    resolved = realpathSync(cwd);
  } catch {
    resolved = cwd;
  }
  return resolved.replace(/[^a-zA-Z0-9]/g, '-');
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

  // REWRITE, not byte-copy (bug #56-class cold-boot root cause, 2026-05-31): a
  // Claude Code transcript record carries its OWN `sessionId` (and `cwd`). A
  // plain copy keeps the PARENT's `sessionId`/`cwd`, so `claude --print --resume
  // <forkedSessionId>` opens the fork file, sees records whose `sessionId` does
  // NOT equal the resume target, rejects them as not-this-session, and boots a
  // FRESH empty session — the clone inherits nothing (verified live: the fork
  // ended up containing only the clone's own session, zero parent content).
  // Stamping each record with the fork's id + the clone's cwd makes `--resume`
  // accept the fork as its own continuation, so the parent conversation is
  // actually replayed into the clone's context.
  let cloneCwdReal: string;
  try {
    cloneCwdReal = realpathSync(args.cloneCwd);
  } catch {
    cloneCwdReal = args.cloneCwd;
  }
  const raw = await fs.readFile(srcPath, 'utf8');
  const rewritten = raw
    .split('\n')
    .map((line) => {
      if (line.trim() === '') return line;
      let rec: unknown;
      try {
        rec = JSON.parse(line);
      } catch {
        return line; // non-JSON line (shouldn't happen) — pass through untouched
      }
      if (rec !== null && typeof rec === 'object') {
        const obj = rec as Record<string, unknown>;
        if ('sessionId' in obj) obj.sessionId = forkedSessionId;
        if ('cwd' in obj) obj.cwd = cloneCwdReal;
        return JSON.stringify(obj);
      }
      return line;
    })
    .join('\n');
  await fs.writeFile(destPath, rewritten, 'utf8');

  return { forkedSessionId };
}
