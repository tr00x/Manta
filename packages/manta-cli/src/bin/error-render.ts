import { isCliError } from '../errors.js';

export interface RenderTopLevelErrorOptions {
  /** When true (MANTA_DEBUG=1), append full Node stack traces. */
  debug: boolean;
}

export interface RenderedError {
  /** stderr lines, each without a trailing newline. */
  lines: string[];
  /** Process exit code to set. */
  exitCode: number;
}

/** Exit code when the `claude` binary is missing (POSIX "command not found"). */
const EXIT_CLAUDE_NOT_ON_PATH = 127;
/** Exit code for an unclassified crash. */
const EXIT_UNEXPECTED = 99;

/**
 * Walk an error's `cause` chain (cycle-safe), oldest-first being the head.
 * Returns the head error plus every linked `cause`.
 */
function errorChain(err: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur != null && !seen.has(cur)) {
    seen.add(cur);
    chain.push(cur);
    cur = (cur as { cause?: unknown }).cause;
  }
  return chain;
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return '';
}

/**
 * Did this error (anywhere in its cause chain) come from the `claude` binary
 * not being on PATH? Two signals:
 *  - a spawn `ENOENT` whose path/command/message mentions `claude`, or
 *  - a CliError whose message already asks "is the claude CLI on PATH?"
 *    (bootstrap/preflight raise exactly this).
 */
function isClaudeNotOnPath(err: unknown): boolean {
  for (const e of errorChain(err)) {
    const rec = e as { code?: unknown; path?: unknown; command?: unknown };
    const haystack = [
      messageOf(e),
      typeof rec.path === 'string' ? rec.path : '',
      typeof rec.command === 'string' ? rec.command : '',
    ].join(' ');
    if (rec.code === 'ENOENT' && /\bclaude\b/i.test(haystack)) return true;
    if (/is the claude CLI on PATH/i.test(messageOf(e))) return true;
  }
  return false;
}

function appendStacks(lines: string[], err: unknown): void {
  for (const e of errorChain(err)) {
    if (e instanceof Error && typeof e.stack === 'string' && e.stack.length > 0) {
      lines.push(e.stack);
    }
  }
}

/**
 * Render a thrown top-level error into clean, operator-facing stderr lines.
 *
 * C2b: the previous top-level catch dumped raw Node stack traces (the
 * CliError's own stack plus `cause.stack`) on every failure — including
 * routine, expected ones like "package not installed" or "claude not on
 * PATH". That buries the actionable one-liner under noise. Now:
 *  - known CliError kinds print a clean `[manta] <message>`;
 *  - "claude not on PATH" is special-cased with an actionable hint;
 *  - raw stack traces appear ONLY under `MANTA_DEBUG=1`.
 */
export function renderTopLevelError(
  err: unknown,
  opts: RenderTopLevelErrorOptions,
): RenderedError {
  const lines: string[] = [];

  if (isClaudeNotOnPath(err)) {
    lines.push('[manta] the `claude` CLI was not found on your PATH.');
    lines.push(
      '[manta] Manta drives Claude Code through the `claude` binary — install Claude Code and ensure `claude` is on your PATH, then retry.',
    );
    if (opts.debug) appendStacks(lines, err);
    // Honour a CliError's own exitCode if present; else POSIX 127.
    return { lines, exitCode: isCliError(err) ? err.exitCode : EXIT_CLAUDE_NOT_ON_PATH };
  }

  if (isCliError(err)) {
    lines.push(`[manta] ${err.message}`);
    if (opts.debug) {
      lines.push(`[manta] kind: ${err.kind}`);
      appendStacks(lines, err);
    }
    return { lines, exitCode: err.exitCode };
  }

  // Unclassified error: a real bug. Keep the one-liner clean; gate the stack.
  lines.push(`[manta] unexpected error: ${messageOf(err) || String(err)}`);
  if (opts.debug) {
    appendStacks(lines, err);
  } else {
    lines.push('[manta] (re-run with MANTA_DEBUG=1 for the full stack trace)');
  }
  return { lines, exitCode: EXIT_UNEXPECTED };
}
