import { describe, it, expect } from 'vitest';
import { CURRENT_SCHEMA_VERSION, isSupportedVersion, migrate } from '../src/version';

describe('schema version', () => {
  it('exposes current version as a positive integer', () => {
    expect(typeof CURRENT_SCHEMA_VERSION).toBe('number');
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(CURRENT_SCHEMA_VERSION)).toBe(true);
  });

  it('treats current version as supported', () => {
    expect(isSupportedVersion(CURRENT_SCHEMA_VERSION)).toBe(true);
  });

  it('rejects future versions', () => {
    expect(isSupportedVersion(CURRENT_SCHEMA_VERSION + 1)).toBe(false);
  });

  it('rejects non-positive versions', () => {
    expect(isSupportedVersion(0)).toBe(false);
    expect(isSupportedVersion(-1)).toBe(false);
  });

  it('rejects non-integer versions', () => {
    expect(isSupportedVersion(1.5)).toBe(false);
  });

  it('returns input unchanged when migrating from current version', () => {
    const data = { version: CURRENT_SCHEMA_VERSION, payload: 'x' };
    expect(migrate(data, CURRENT_SCHEMA_VERSION)).toBe(data);
  });

  it('returns input unchanged when migrating from v1 (current)', () => {
    const data = { version: 1, payload: 'y' };
    expect(migrate(data, 1)).toBe(data);
  });

  it('throws when migrating from unsupported (too-new) version', () => {
    expect(() => migrate({ version: 99 }, 99)).toThrow(/unsupported/i);
  });

  it('throws when migrating from unsupported (non-integer) version', () => {
    expect(() => migrate({}, 1.5)).toThrow(/unsupported/i);
  });

  it('throws when migrating from unsupported (zero) version', () => {
    expect(() => migrate({}, 0)).toThrow(/unsupported/i);
  });
});
