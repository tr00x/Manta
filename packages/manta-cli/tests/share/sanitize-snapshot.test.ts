import { describe, it, expect } from 'vitest';
import { sanitizeSnapshot } from '../../src/share/sanitize-snapshot.js';
import { SanitizedSnapshotSchema, CURRENT_SCHEMA_VERSION, type Snapshot } from '@manta/snapshot';

const ROOT = '/Users/x/projectos/manta';

const fullSnapshot = (overrides: Partial<Snapshot> = {}): Snapshot =>
  ({
    version: CURRENT_SCHEMA_VERSION,
    castId: 'cast-1',
    parentSessionId: 'sess-internal-123',
    resumeEnabled: false,
    parentPid: 4242,
    createdAt: '2026-05-29T02:13:12.386Z',
    taskContract: {
      cloneId: 'B',
      mode: 'forking-realities',
      task: 'do x',
      scope: { allowedPaths: ['.'], forbiddenPaths: ['.manta/state'], maxFilesChanged: 30 },
      approachHint: null,
      siblingClones: ['A'],
      deadlineSeconds: 1200,
      sessionMode: 'batch',
    },
    recentMessages: [{ role: 'user', content: 'hi', timestamp: '2026-05-29T02:13:00.000Z' }],
    activeTodos: [{ id: '1', subject: 't', status: 'pending' }],
    openFiles: [{ path: `${ROOT}/src/a.ts`, reason: 'edit' }],
    parentWorktree: ROOT,
    cloneWorktree: `${ROOT}/.manta/worktrees/clone-B`,
    mode: 'forking-realities',
    budget: { tokensTotal: 0, tokensUsed: 0, tokensEstimatedTotal: 5, tokensEstimatedUsed: 0 },
    ttlSeconds: 1200,
    siblingCloneIds: ['A'],
    sessionMode: 'batch',
    sessionId: 'internal-sess',
    ...overrides,
  }) as Snapshot;

describe('sanitizeSnapshot', () => {
  it('replaces parentWorktree with the <worktree> marker (no warning)', () => {
    const { sanitized, warnings } = sanitizeSnapshot(fullSnapshot());
    expect(sanitized.parentWorktree).toBe('<worktree>');
    expect(warnings.some((w) => w.rule === 'snapshot.parentWorktree')).toBe(false);
  });

  it('replaces cloneWorktree with <worktree>/clone-<id>', () => {
    const { sanitized } = sanitizeSnapshot(fullSnapshot());
    expect(sanitized.cloneWorktree).toBe('<worktree>/clone-B');
  });

  it('drops non-empty recentMessages and emits one warning', () => {
    const { sanitized, warnings } = sanitizeSnapshot(fullSnapshot());
    expect('recentMessages' in sanitized).toBe(false);
    const w = warnings.filter((x) => x.rule === 'snapshot.recentMessages');
    expect(w.length).toBe(1);
    expect(w[0]!.message).toContain('1');
  });

  it('emits no recentMessages warning when the array is empty', () => {
    const { warnings } = sanitizeSnapshot(fullSnapshot({ recentMessages: [] }));
    expect(warnings.some((w) => w.rule === 'snapshot.recentMessages')).toBe(false);
  });

  it('relativises an in-repo openFile path to repo root', () => {
    const { sanitized } = sanitizeSnapshot(fullSnapshot());
    expect(sanitized.openFiles).toEqual([{ path: 'src/a.ts', reason: 'edit' }]);
  });

  it('drops an out-of-repo openFile entry with a warning', () => {
    const { sanitized, warnings } = sanitizeSnapshot(
      fullSnapshot({ openFiles: [{ path: '/etc/passwd', reason: 'x' }] }),
    );
    expect(sanitized.openFiles).toEqual([]);
    expect(warnings.some((w) => w.rule === 'snapshot.openFiles')).toBe(true);
  });

  it('omits parentPid, parentSessionId, budget, and sessionId entirely', () => {
    const { sanitized } = sanitizeSnapshot(fullSnapshot());
    const keys = Object.keys(sanitized);
    expect(keys).not.toContain('parentPid');
    expect(keys).not.toContain('parentSessionId');
    expect(keys).not.toContain('budget');
    expect(keys).not.toContain('sessionId');
  });

  it('produces output that always validates against SanitizedSnapshotSchema', () => {
    for (const snap of [
      fullSnapshot(),
      fullSnapshot({ recentMessages: [] }),
      fullSnapshot({ openFiles: [{ path: '/etc/passwd', reason: 'x' }] }),
    ]) {
      const { sanitized } = sanitizeSnapshot(snap);
      const r = SanitizedSnapshotSchema.safeParse(sanitized);
      expect(r.success, JSON.stringify(r)).toBe(true);
    }
  });

  it('keeps createdAt, castId, mode, taskContract, ttlSeconds, siblingCloneIds, sessionMode', () => {
    const { sanitized } = sanitizeSnapshot(fullSnapshot());
    expect(sanitized.createdAt).toBe('2026-05-29T02:13:12.386Z');
    expect(sanitized.castId).toBe('cast-1');
    expect(sanitized.mode).toBe('forking-realities');
    expect(sanitized.taskContract.cloneId).toBe('B');
    expect(sanitized.ttlSeconds).toBe(1200);
    expect(sanitized.siblingCloneIds).toEqual(['A']);
    expect(sanitized.sessionMode).toBe('batch');
  });

  it('keeps resumeEnabled (RB1/bug #56 — harmless boolean, required by .strict allow-list)', () => {
    const { sanitized } = sanitizeSnapshot(fullSnapshot({ resumeEnabled: true }));
    expect(sanitized.resumeEnabled).toBe(true);
  });
});
