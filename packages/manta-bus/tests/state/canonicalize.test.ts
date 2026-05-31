import { describe, it, expect } from 'vitest';
import { canonicalize } from '../../src/state/canonicalize';

describe('canonicalize', () => {
  it('returns primitives unchanged', () => {
    expect(canonicalize(1)).toBe(1);
    expect(canonicalize('s')).toBe('s');
    expect(canonicalize(null)).toBe(null);
    expect(canonicalize(undefined)).toBe(undefined);
    expect(canonicalize(true)).toBe(true);
  });

  it('sorts object keys alphabetically', () => {
    const out = canonicalize({ b: 1, a: 2 }) as Record<string, number>;
    expect(Object.keys(out)).toEqual(['a', 'b']);
  });

  it('preserves array order', () => {
    expect(canonicalize([3, 1, 2])).toEqual([3, 1, 2]);
  });

  it('recurses into nested objects + arrays', () => {
    const out = JSON.stringify(canonicalize({ z: [{ b: 1, a: 2 }, { d: 3 }], a: 1 }));
    expect(out).toBe('{"a":1,"z":[{"a":2,"b":1},{"d":3}]}');
  });

  it('two key-permuted objects stringify identically', () => {
    const a = JSON.stringify(canonicalize({ task: 't', token_estimate: 5 }));
    const b = JSON.stringify(canonicalize({ token_estimate: 5, task: 't' }));
    expect(a).toBe(b);
  });
});
