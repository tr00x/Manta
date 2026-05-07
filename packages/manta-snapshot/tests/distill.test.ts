import { describe, it, expect } from 'vitest';
import { distillContext } from '../src/distill';

describe('distillContext', () => {
  it('keeps only the last N messages when over the limit', () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({
      role: 'user' as const,
      content: `msg-${i}`,
      timestamp: '2026-05-06T10:00:00.000Z',
    }));
    const out = distillContext({ messages, openFiles: [], maxRecentMessages: 10 });
    expect(out.recentMessages).toHaveLength(10);
    expect(out.recentMessages[0].content).toBe('msg-40');
    expect(out.recentMessages[9].content).toBe('msg-49');
  });

  it('keeps all messages when under the limit', () => {
    const messages = [
      { role: 'user' as const, content: 'a', timestamp: '2026-05-06T10:00:00.000Z' },
      { role: 'assistant' as const, content: 'b', timestamp: '2026-05-06T10:00:01.000Z' },
    ];
    const out = distillContext({ messages, openFiles: [], maxRecentMessages: 10 });
    expect(out.recentMessages).toHaveLength(2);
  });

  it('filters open files to only those overlapping with allowedPaths', () => {
    const openFiles = [
      { path: 'src/a.ts', reason: 'r' },
      { path: 'docs/b.md', reason: 'r' },
      { path: 'secrets/c.env', reason: 'r' },
    ];
    const out = distillContext({
      messages: [],
      openFiles,
      maxRecentMessages: 10,
      allowedPaths: ['src/', 'docs/'],
    });
    expect(out.openFiles.map((f) => f.path)).toEqual(['src/a.ts', 'docs/b.md']);
  });

  it('returns all open files unfiltered when no allowedPaths provided', () => {
    const openFiles = [
      { path: 'src/a.ts', reason: 'r' },
      { path: 'secrets/c.env', reason: 'r' },
    ];
    const out = distillContext({ messages: [], openFiles, maxRecentMessages: 10 });
    expect(out.openFiles).toHaveLength(2);
  });

  it('throws on non-positive maxRecentMessages', () => {
    expect(() =>
      distillContext({ messages: [], openFiles: [], maxRecentMessages: 0 }),
    ).toThrow(/maxRecentMessages/);
  });
});
