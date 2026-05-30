import { InvalidArgumentError } from 'commander';

/**
 * Commander coercer for integer-valued flags whose parsed value GATES a
 * safety behaviour. A bare `parseInt` returns `NaN` on non-numeric input,
 * and every downstream comparison against `NaN` (`size > NaN`,
 * `age > NaN`) is `false` — which SILENTLY DISABLES the guard the flag
 * exists to drive. Concretely, `--distill-threshold-bytes abc` would make
 * the transcript size-guard never trip and copy an arbitrarily large
 * parent transcript into every clone. Reject anything that is not a clean
 * positive integer at the CLI boundary so a typo fails loud instead of
 * disarming the guard. `parseInt`'s trailing-garbage leniency (`5abc` → 5)
 * is also rejected here on purpose: a half-parsed threshold is a silent
 * wrong value, not a safe one.
 */
export function parsePositiveIntOption(raw: string): number {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new InvalidArgumentError('expected a positive integer');
  }
  const n = Number.parseInt(trimmed, 10);
  if (n <= 0) {
    throw new InvalidArgumentError('expected a positive integer');
  }
  return n;
}

/**
 * Commander coercer for dollar-valued flags whose parsed value GATES a money
 * guard. Bug #60 class: `--daily-cap-usd`, `--budget-per-cast-usd`, and
 * `--budget-per-clone-usd` were parsed with a bare `parseFloat`, which returns
 * `NaN` on garbage. Every budget comparison is then dead: `spend > NaN` and
 * `projected > NaN` are both `false`, so the ceiling the flag exists to enforce
 * is SILENTLY DISABLED — a typo'd `--daily-cap-usd abc` removes the cap instead
 * of erroring. Reject anything that is not a clean, finite, strictly-positive
 * decimal at the CLI boundary so a typo fails loud. A `$0` money budget is
 * meaningless (it can never pass a non-zero cost gate) so it is rejected too;
 * "positive" here means `> 0`. `parseFloat`'s trailing-garbage leniency
 * (`5abc` → 5) and scientific notation (`1e3`) are rejected on purpose: a
 * half-parsed budget is a silent wrong value, not a safe one.
 */
export function parsePositiveFloatOption(raw: string): number {
  const trimmed = raw.trim();
  // Strict decimal: optional integer part, optional single dot, ≥1 digit.
  // Accepts "5", "5.5", "0.5", ".5"; rejects "", "5.", "-5", "1e3", "5abc".
  if (!/^\d*\.?\d+$/.test(trimmed)) {
    throw new InvalidArgumentError('expected a positive number');
  }
  const n = Number.parseFloat(trimmed);
  if (!Number.isFinite(n) || n <= 0) {
    throw new InvalidArgumentError('expected a positive number');
  }
  return n;
}

/**
 * Commander coercer for integer-valued flags where `0` is a MEANINGFUL value,
 * not a disabled guard. The sole user today is `--max-files-changed`, where
 * `0` = read-only (a clone that may write nothing) and is perfectly valid —
 * so {@link parsePositiveIntOption} (which rejects `0`) would be wrong here.
 * A bare `parseInt` still has the NaN-disarm hazard: `parseInt('abc', 10)` is
 * `NaN`, and a downstream `Number.isInteger(NaN)` guard would reject it with a
 * confusing "got NaN" message instead of a clean "expected a non-negative
 * integer". `parseInt`'s trailing-garbage leniency (`5abc` → 5) is rejected on
 * purpose. Negatives are rejected by the `\d+`-only pattern (no leading minus).
 */
export function parseNonNegativeIntOption(raw: string): number {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new InvalidArgumentError('expected a non-negative integer (0 = read-only)');
  }
  return Number.parseInt(trimmed, 10);
}
