import type { Mode } from '@manta/bus';
import { CliError } from '../errors.js';

/**
 * Aghanim's Scepter gate (spec Sec 6.6).
 *
 * `decoy`, `council`, and `phantom-lance` are high-power / higher-risk modes
 * that ship LOCKED. The operator must explicitly opt in before a cast of one
 * of these modes is allowed to spawn. There are two unlock channels, OR'd
 * together:
 *
 *   1. Config — `.manta/config/budget.json` → `aghs.unlocked: ["decoy", ...]`
 *      (persistent, per-repo, the recommended channel).
 *   2. Env — `MANTA_UNLOCK_AGHS` (ephemeral, per-invocation; handy for CI and
 *      one-off runs). Accepts a comma/space-separated list of mode names, or
 *      one of the wildcards `all` / `1` / `true` (case-insensitive) which
 *      unlocks every *safe* Aghs mode.
 *
 * IMPORTANT: `phantom-lance` (recursive self-cast) is intentionally NOT part of
 * the `all` wildcard — it remains locked unless named explicitly, and it is
 * additionally gated by not being in the cast dispatcher's BUILTIN_MODES set
 * (so a `manta cast phantom-lance` is rejected as "not supported" before this
 * gate is even reached). This module is generic on purpose: the lock for
 * phantom-lance is enforced upstream, and naming it here changes nothing.
 */
export const AGHS_LOCKED_MODES: ReadonlySet<Mode> = new Set<Mode>([
  'decoy',
  'council',
  'phantom-lance',
]);

/**
 * Modes the `all` / `1` / `true` env wildcard unlocks. Deliberately excludes
 * `phantom-lance` so a blanket "unlock the safe advanced modes" never lights up
 * recursive self-cast by accident (task fence: keep phantom-lance locked).
 */
const WILDCARD_UNLOCK_MODES: readonly Mode[] = ['decoy', 'council'];

const WILDCARD_TOKENS: ReadonlySet<string> = new Set(['all', '1', 'true', 'yes', '*']);

export function isAghsLocked(mode: Mode): boolean {
  return AGHS_LOCKED_MODES.has(mode);
}

/**
 * Parse the `MANTA_UNLOCK_AGHS` env value into a set of unlocked modes. Unknown
 * tokens are ignored (a typo never silently unlocks the wrong mode, and never
 * throws). Returns an empty set for undefined/empty input.
 */
export function parseAghsUnlockEnv(raw: string | undefined): Set<Mode> {
  const out = new Set<Mode>();
  if (raw == null) return out;
  const tokens = raw
    .split(/[,\s]+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  for (const tok of tokens) {
    if (WILDCARD_TOKENS.has(tok)) {
      for (const m of WILDCARD_UNLOCK_MODES) out.add(m);
      continue;
    }
    if (AGHS_LOCKED_MODES.has(tok as Mode)) {
      out.add(tok as Mode);
    }
  }
  return out;
}

/**
 * Compute the effective set of unlocked Aghs modes from the config list and the
 * env var, OR'd. `configUnlocked` is the validated `aghs.unlocked` array from
 * BudgetConfig (already constrained to valid mode names by the Zod schema).
 */
export function resolveUnlockedAghsModes(
  configUnlocked: readonly Mode[],
  env: NodeJS.ProcessEnv = process.env,
): Set<Mode> {
  const out = parseAghsUnlockEnv(env.MANTA_UNLOCK_AGHS);
  for (const m of configUnlocked) {
    if (AGHS_LOCKED_MODES.has(m)) out.add(m);
  }
  return out;
}

export function aghsLockedMessage(mode: Mode): string {
  return (
    `mode "${mode}" is an Aghanim's-locked advanced mode and is disabled by default ` +
    `(spec Sec 6.6). Unlock it before casting:\n` +
    `  • config:  add "${mode}" to "aghs.unlocked" in .manta/config/budget.json, e.g. ` +
    `{ "aghs": { "unlocked": ["${mode}"] } }\n` +
    `  • env:     run with MANTA_UNLOCK_AGHS=${mode} (or MANTA_UNLOCK_AGHS=all for every safe advanced mode)`
  );
}

/**
 * Throw a clear, actionable CliError if `mode` is Aghs-locked and not unlocked
 * via either channel. No-op for unlocked or non-Aghs modes.
 */
export function assertAghsUnlocked(mode: Mode, unlocked: ReadonlySet<Mode>): void {
  if (!isAghsLocked(mode)) return;
  if (unlocked.has(mode)) return;
  throw new CliError(aghsLockedMessage(mode), { kind: 'invalid_input' });
}
