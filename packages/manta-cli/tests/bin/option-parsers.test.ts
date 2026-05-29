import { describe, it, expect } from 'vitest';
import { InvalidArgumentError } from 'commander';
import { parsePositiveIntOption } from '../../src/bin/option-parsers.js';

/**
 * RB1 hardening (Chunk 2/3 code-reviewer nit): the transcript size-guard is
 * driven by --distill-threshold-bytes. A bare `parseInt` coercer returns NaN
 * on bad input, and `size > NaN` is always false — silently disarming the
 * guard and copying an 11.7 MB transcript into every clone. These tests pin
 * the strict positive-integer coercion that fails loud instead.
 */
describe('parsePositiveIntOption', () => {
  it('parses a clean positive integer', () => {
    expect(parsePositiveIntOption('2000000')).toBe(2_000_000);
    expect(parsePositiveIntOption('1')).toBe(1);
  });

  it('trims surrounding whitespace', () => {
    expect(parsePositiveIntOption('  42  ')).toBe(42);
  });

  it('accepts leading zeros as decimal', () => {
    expect(parsePositiveIntOption('007')).toBe(7);
  });

  it('rejects non-numeric input (the NaN-disarms-the-guard case)', () => {
    expect(() => parsePositiveIntOption('abc')).toThrow(InvalidArgumentError);
  });

  it('rejects the empty string', () => {
    expect(() => parsePositiveIntOption('')).toThrow(InvalidArgumentError);
  });

  it('rejects trailing garbage instead of half-parsing it (strict over parseInt)', () => {
    // bare parseInt('5abc', 10) === 5 — a silent wrong value; we reject it.
    expect(() => parsePositiveIntOption('5abc')).toThrow(InvalidArgumentError);
  });

  it('rejects negatives', () => {
    expect(() => parsePositiveIntOption('-5')).toThrow(InvalidArgumentError);
  });

  it('rejects zero (a 0-byte threshold disables inheritance entirely)', () => {
    expect(() => parsePositiveIntOption('0')).toThrow(InvalidArgumentError);
  });

  it('rejects a floating-point value', () => {
    expect(() => parsePositiveIntOption('5.9')).toThrow(InvalidArgumentError);
  });

  it('reports a positive-integer error message', () => {
    expect(() => parsePositiveIntOption('nope')).toThrow(/positive integer/);
  });
});
