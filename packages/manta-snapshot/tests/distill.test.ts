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
    expect(out.recentMessages.length).toBe(10);
    const first = out.recentMessages[0];
    const last = out.recentMessages[9];
    if (!first || !last) throw new Error('expected 10 messages');
    expect(first.content).toBe('msg-40');
    expect(last.content).toBe('msg-49');
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

  it('rejects sibling-prefix path that is not a real segment match (allowedPaths: ["src"])', () => {
    const openFiles = [
      { path: 'srcret/leak.env', reason: 'r' },
      { path: 'src/a.ts', reason: 'r' },
    ];
    const out = distillContext({
      messages: [],
      openFiles,
      maxRecentMessages: 10,
      allowedPaths: ['src'],
    });
    expect(out.openFiles.map((f) => f.path)).toEqual(['src/a.ts']);
  });

  it('rejects sibling-prefix path that is not a real segment match (allowedPaths: ["src/"])', () => {
    const openFiles = [
      { path: 'srcret/leak.env', reason: 'r' },
      { path: 'src/a.ts', reason: 'r' },
    ];
    const out = distillContext({
      messages: [],
      openFiles,
      maxRecentMessages: 10,
      allowedPaths: ['src/'],
    });
    expect(out.openFiles.map((f) => f.path)).toEqual(['src/a.ts']);
  });

  it('rejects path traversal via .. segments', () => {
    const openFiles = [
      { path: 'src/../secrets/x.env', reason: 'r' },
      { path: 'src/inner/x.ts', reason: 'r' },
    ];
    const out = distillContext({
      messages: [],
      openFiles,
      maxRecentMessages: 10,
      allowedPaths: ['src/'],
    });
    expect(out.openFiles.map((f) => f.path)).toEqual(['src/inner/x.ts']);
  });

  it('includes a path that exactly equals an allowed path (file path)', () => {
    const openFiles = [
      { path: 'LICENSE', reason: 'r' },
      { path: 'README.md', reason: 'r' },
    ];
    const out = distillContext({
      messages: [],
      openFiles,
      maxRecentMessages: 10,
      allowedPaths: ['LICENSE'],
    });
    expect(out.openFiles.map((f) => f.path)).toEqual(['LICENSE']);
  });

  it('includes nested files under an allowed dir (sanity for happy path)', () => {
    const openFiles = [{ path: 'src/inner/x.ts', reason: 'r' }];
    const out = distillContext({
      messages: [],
      openFiles,
      maxRecentMessages: 10,
      allowedPaths: ['src/'],
    });
    expect(out.openFiles.map((f) => f.path)).toEqual(['src/inner/x.ts']);
  });
});
