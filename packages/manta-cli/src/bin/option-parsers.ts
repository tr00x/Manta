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
 * Commander coercer for integer-valued flags where `0` is a MEANINGFUL value,
 * not a disabled guard. Users: `--max-files-changed` (`0` = read-only, a clone
 * that may write nothing) and the `--since` timestamp filters on replay/audit
 * (`0` = from epoch) — bug #60. For these {@link parsePositiveIntOption} (which
 * rejects `0`) would be wrong. A bare `parseInt` still has the NaN-disarm
 * hazard: `parseInt('abc', 10)` is `NaN`, and a downstream comparison against
 * `NaN` is always false — silently disabling the filter/guard. `parseInt`'s
 * trailing-garbage leniency (`5abc` → 5) is rejected on purpose. Negatives are
 * rejected by the `\d+`-only pattern (no leading minus). The message is generic
 * (no flag-specific hint) because the coercer is shared; each flag's own
 * `.option()` description carries any per-flag meaning of `0`.
 */
export function parseNonNegativeIntOption(raw: string): number {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new InvalidArgumentError('expected a non-negative integer');
  }
  return Number.parseInt(trimmed, 10);
}
