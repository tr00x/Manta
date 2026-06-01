#!/usr/bin/env node
// manta-statusline.ts — Tier 0 observability: a conditional Claude Code
// statusLine that shows live Manta clone state and elapsed time — but ONLY
// while a cast is running. When no clone is live it prints an EMPTY string and
// Claude Code hides the row entirely (zero chrome when idle).
//
// Hard constraints (G-ux-observability.md script spec):
//   - FAST: pure synchronous file reads, no child process, no MCP, no network.
//     Claude Code re-invokes this on `refreshInterval` while the main agent
//     waits on clones, so it must finish well under ~100ms.
//   - NEVER THROW: any error (missing repo, malformed JSON, permission denied)
//     resolves to an empty string. A statusline that crashes is worse than one
//     that says nothing.
//   - SELF-CONTAINED: only node builtins (fs/path/url). The plugin bundle has no
//     node_modules to fall back on for an always-on hot path, and zero deps is
//     the cheapest way to stay fast.
//
// There is NO usage/spend segment: Claude Code is a subscription, not pay-per-
// token, so a token meter is meaningless. The line shows what is actually
// actionable — which clones are live and how long they have been running.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Minimal shape of a clone record in registry.json we actually consume. */
export interface StatuslineClone {
  readonly clone_id: string;
  readonly state: string;
  readonly registered_at?: number;
}

/** Pure inputs to the formatter — everything I/O-derived is resolved upstream. */
export interface StatuslineInput {
  readonly clones: readonly StatuslineClone[];
  /** Wall-clock now, in ms — injected so the formatter stays pure/testable. */
  readonly nowMs: number;
}

// ⧉ (U+29C9) — the Manta marker: two joined squares = duplication/cloning, the
// essence of the self-cloning pattern. Monochrome, renders cleanly in any
// terminal (no emoji-presentation variance).
const MARK = '⧉';
const STATE_ARROW = '▶'; // ▶
const SEP = ' · '; // " · "

/**
 * Render the one-line statusline. Returns '' when there are no live clones —
 * that empty string is the signal Claude Code uses to hide the row. Pure: no
 * I/O, no clock access (now is injected). Never throws.
 *
 * Example: `⧉ A▶WORKING B▶WINDING_DOWN · 4m`
 */
export function formatStatusline(input: StatuslineInput): string {
  const live = input.clones.filter((c) => isLive(c.state));
  if (live.length === 0) {
    return '';
  }

  const segments: string[] = [];

  // Segment 1: per-clone `<id>▶<STATE>`, in registry order.
  segments.push(live.map((c) => `${c.clone_id}${STATE_ARROW}${c.state}`).join(' '));

  // Segment 2: elapsed time since the oldest live clone registered.
  const oldest = oldestRegisteredAt(live);
  if (oldest != null) {
    const elapsedMs = Math.max(0, input.nowMs - oldest);
    segments.push(formatDuration(elapsedMs));
  }

  return `${MARK} ${segments.join(SEP)}`;
}

/** A clone counts as "live" for the statusline unless it is terminally DEAD. */
export function isLive(state: string): boolean {
  return state !== 'DEAD';
}

function oldestRegisteredAt(clones: readonly StatuslineClone[]): number | null {
  let min: number | null = null;
  for (const c of clones) {
    if (typeof c.registered_at === 'number' && Number.isFinite(c.registered_at)) {
      if (min == null || c.registered_at < min) {
        min = c.registered_at;
      }
    }
  }
  return min;
}

/** Compact elapsed: `<60s`→`Ns`, `<60m`→`Nm`, else `HhMm`. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h${minutes}m`;
}

/**
 * Walk up from `startDir` to the nearest ancestor containing a `.git` entry
 * (file OR directory — git worktrees use a `.git` file). Mirrors how the CLI
 * locates the repo root. Returns null if none is found.
 */
export function resolveRepoRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  // Bounded by filesystem root; `path.dirname('/') === '/'` terminates the walk.
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

function readJson(file: string): unknown {
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw) as unknown;
}

/** Read live clones from registry.json. Returns [] on any failure. */
export function readClones(repoRoot: string): StatuslineClone[] {
  try {
    const data = readJson(path.join(repoRoot, '.manta', 'state', 'registry.json'));
    const clones = (data as { clones?: Record<string, unknown> }).clones;
    if (clones == null || typeof clones !== 'object') {
      return [];
    }
    const out: StatuslineClone[] = [];
    for (const value of Object.values(clones)) {
      if (value == null || typeof value !== 'object') {
        continue;
      }
      const rec = value as Record<string, unknown>;
      if (typeof rec.clone_id === 'string' && typeof rec.state === 'string') {
        out.push({
          clone_id: rec.clone_id,
          state: rec.state,
          ...(typeof rec.registered_at === 'number' ? { registered_at: rec.registered_at } : {}),
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** End-to-end: resolve root, read state, format. Returns '' on any failure. */
export function computeStatusline(startDir: string, nowMs: number): string {
  try {
    const repoRoot = resolveRepoRoot(startDir);
    if (repoRoot == null) {
      return '';
    }
    return formatStatusline({
      clones: readClones(repoRoot),
      nowMs,
    });
  } catch {
    return '';
  }
}

/** Entry point: print the line (or empty) and exit 0 no matter what. */
export function runStatusline(): void {
  let line = '';
  try {
    line = computeStatusline(process.cwd(), Date.now());
  } catch {
    line = '';
  }
  // A single write; no trailing newline so the row stays tight. An empty string
  // writes nothing, which Claude Code treats as "hide the statusline".
  process.stdout.write(line);
}

// Run only when executed directly (`node manta-statusline.cjs`), never on import
// — tests import the formatter without triggering a file-reading print.
const invokedDirectly = (() => {
  try {
    return process.argv[1] != null && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  runStatusline();
}
