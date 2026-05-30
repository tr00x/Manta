import { describe, it, expect } from 'vitest';
import { InvalidArgumentError } from 'commander';
import {
  parsePositiveIntOption,
  parsePositiveFloatOption,
  parseNonNegativeIntOption,
} from '../../src/bin/option-parsers.js';

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

/**
 * Bug #60 class: the money flags (--daily-cap-usd, --budget-per-cast-usd,
 * --budget-per-clone-usd) were parsed with a bare `parseFloat`. NaN flows
 * through and every budget comparison (`spend > NaN`, `projected > NaN`) is
 * `false`, so the ceiling is silently disabled. These tests pin the strict
 * positive-decimal coercion that fails loud instead.
 */
describe('parsePositiveFloatOption', () => {
  it('parses a clean positive decimal', () => {
    expect(parsePositiveFloatOption('5')).toBe(5);
    expect(parsePositiveFloatOption('5.5')).toBe(5.5);
    expect(parsePositiveFloatOption('0.5')).toBe(0.5);
    expect(parsePositiveFloatOption('.5')).toBe(0.5);
    expect(parsePositiveFloatOption('50')).toBe(50);
  });

  it('trims surrounding whitespace', () => {
    expect(parsePositiveFloatOption('  12.75  ')).toBe(12.75);
  });

  it('rejects non-numeric input (the NaN-disarms-the-guard case)', () => {
    expect(() => parsePositiveFloatOption('abc')).toThrow(InvalidArgumentError);
  });

  it('rejects the empty string', () => {
    expect(() => parsePositiveFloatOption('')).toThrow(InvalidArgumentError);
  });

  it('rejects negatives', () => {
    expect(() => parsePositiveFloatOption('-5')).toThrow(InvalidArgumentError);
    expect(() => parsePositiveFloatOption('-0.5')).toThrow(InvalidArgumentError);
  });

  it('rejects zero (a $0 money budget can never clear a non-zero cost gate)', () => {
    expect(() => parsePositiveFloatOption('0')).toThrow(InvalidArgumentError);
    expect(() => parsePositiveFloatOption('0.0')).toThrow(InvalidArgumentError);
  });

  it('rejects trailing garbage instead of half-parsing it (strict over parseFloat)', () => {
    // bare parseFloat('5abc') === 5 — a silent wrong value; we reject it.
    expect(() => parsePositiveFloatOption('5abc')).toThrow(InvalidArgumentError);
  });

  it('rejects scientific notation (ambiguous, fail loud)', () => {
    expect(() => parsePositiveFloatOption('1e3')).toThrow(InvalidArgumentError);
  });

  it('rejects a trailing-dot value', () => {
    expect(() => parsePositiveFloatOption('5.')).toThrow(InvalidArgumentError);
  });

  it('reports a positive-number error message', () => {
    expect(() => parsePositiveFloatOption('nope')).toThrow(/positive number/);
  });
});

/**
 * Bug #60 class for --max-files-changed, where `0` is a MEANINGFUL value
 * (read-only clone) and must NOT be rejected — so the positive-int coercer is
 * wrong here. A bare `parseInt` still admits NaN and trailing garbage; this
 * coercer rejects those while accepting 0.
 */
describe('parseNonNegativeIntOption', () => {
  it('parses a clean non-negative integer', () => {
    expect(parseNonNegativeIntOption('5')).toBe(5);
    expect(parseNonNegativeIntOption('20')).toBe(20);
  });

  it('accepts zero (0 = read-only is valid, unlike the positive variant)', () => {
    expect(parseNonNegativeIntOption('0')).toBe(0);
  });

  it('trims surrounding whitespace', () => {
    expect(parseNonNegativeIntOption('  3  ')).toBe(3);
  });

  it('rejects non-numeric input (the NaN-disarms case)', () => {
    expect(() => parseNonNegativeIntOption('abc')).toThrow(InvalidArgumentError);
  });

  it('rejects the empty string', () => {
    expect(() => parseNonNegativeIntOption('')).toThrow(InvalidArgumentError);
  });

  it('rejects negatives', () => {
    expect(() => parseNonNegativeIntOption('-1')).toThrow(InvalidArgumentError);
  });

  it('rejects a floating-point value', () => {
    expect(() => parseNonNegativeIntOption('5.9')).toThrow(InvalidArgumentError);
  });

  it('rejects trailing garbage instead of half-parsing it', () => {
    expect(() => parseNonNegativeIntOption('5abc')).toThrow(InvalidArgumentError);
  });

  it('reports a non-negative-integer error message', () => {
    expect(() => parseNonNegativeIntOption('nope')).toThrow(/non-negative integer/);
  });
});
