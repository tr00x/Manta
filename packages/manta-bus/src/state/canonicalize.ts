/**
 * Recursively canonicalize a value for stable equality comparison:
 *   - Object keys are sorted alphabetically (insertion-order-independent).
 *   - Arrays are left in their original order — array order may carry
 *     semantic meaning in our schemas (e.g. `sibling_clones` priority,
 *     `allowed_paths` precedence). Sorting them would silently equate
 *     semantically-different shapes.
 *   - Primitives are returned as-is.
 *
 * Original site: state/contracts.ts (Phase 0b). Extracted in Phase 2a when
 * state/casts.ts became a second caller — sharing avoids drift on a
 * recursive function with subtle correctness reasoning.
 */
export function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v !== null && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj)
        .sort()
        .map((k) => [k, canonicalize(obj[k])]),
    );
  }
  return v;
}
