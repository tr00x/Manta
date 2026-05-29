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
