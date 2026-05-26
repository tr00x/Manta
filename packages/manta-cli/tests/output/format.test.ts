import { describe, it, expect } from 'vitest';
import {
  formatTimestamp,
  formatRelativeTime,
  truncate,
  formatOffsetSeconds,
} from '../../src/output/format.js';

describe('formatTimestamp', () => {
  it('returns HH:mm:ss.SSS for a known epoch', () => {
    const ts = new Date('2026-05-26T14:05:03.123Z').getTime();
    const result = formatTimestamp(ts);
    expect(result).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
  });
});

describe('formatRelativeTime', () => {
  it('formats 0ms', () => {
    expect(formatRelativeTime(0)).toBe('0s ago');
  });

  it('formats seconds', () => {
    expect(formatRelativeTime(3000)).toBe('3s ago');
  });

  it('formats minutes and seconds', () => {
    expect(formatRelativeTime(252_000)).toBe('4m 12s ago');
  });

  it('formats hours and minutes', () => {
    expect(formatRelativeTime(3_900_000)).toBe('1h 5m ago');
  });

  it('drops zero sub-units', () => {
    expect(formatRelativeTime(60_000)).toBe('1m 0s ago');
  });
});

describe('truncate', () => {
  it('leaves short strings unchanged', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates long strings with ...', () => {
    expect(truncate('hello world', 8)).toBe('hello...');
  });

  it('handles exact boundary', () => {
    expect(truncate('exact', 5)).toBe('exact');
  });

  it('handles maxLen < 4 gracefully', () => {
    expect(truncate('hello', 3)).toBe('...');
  });
});

describe('formatOffsetSeconds', () => {
  it('formats zero offset', () => {
    expect(formatOffsetSeconds(1000, 1000)).toBe('+0.0s');
  });

  it('formats seconds with one decimal', () => {
    expect(formatOffsetSeconds(0, 45_300)).toBe('+45.3s');
  });

  it('formats minutes and seconds', () => {
    expect(formatOffsetSeconds(0, 135_000)).toBe('+2m 15.0s');
  });

  it('formats negative offsets (event before base) as +0.0s', () => {
    expect(formatOffsetSeconds(5000, 3000)).toBe('+0.0s');
  });
});
