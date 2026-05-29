import { describe, it, expect } from 'vitest';
import { SanitizedSnapshotSchema } from '../src/sanitized-schema';
import { CURRENT_SCHEMA_VERSION } from '../src/version';

const validSanitized = (): Record<string, unknown> => ({
  version: CURRENT_SCHEMA_VERSION,
  castId: 'cast-1',
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
  activeTodos: [{ id: '1', subject: 't', status: 'pending' }],
  openFiles: [{ path: 'src/a.ts', reason: 'edit' }],
  parentWorktree: '<worktree>',
  cloneWorktree: '<worktree>/clone-B',
  mode: 'forking-realities',
  ttlSeconds: 1200,
  siblingCloneIds: ['A'],
  sessionMode: 'batch',
  resumeEnabled: false,
});

describe('SanitizedSnapshotSchema', () => {
  it('parses a fully sanitized snapshot', () => {
    const r = SanitizedSnapshotSchema.safeParse(validSanitized());
    expect(r.success).toBe(true);
  });

  it('requires parentWorktree to be the literal <worktree> marker', () => {
    const r = SanitizedSnapshotSchema.safeParse({ ...validSanitized(), parentWorktree: '/Users/x/repo' });
    expect(r.success).toBe(false);
  });

  it('rejects a leaked parentSessionId (.strict drops the dropped fields)', () => {
    const r = SanitizedSnapshotSchema.safeParse({ ...validSanitized(), parentSessionId: 'sess-1' });
    expect(r.success).toBe(false);
  });

  it('rejects a leaked parentPid', () => {
    const r = SanitizedSnapshotSchema.safeParse({ ...validSanitized(), parentPid: 4242 });
    expect(r.success).toBe(false);
  });

  it('rejects a leaked budget block', () => {
    const r = SanitizedSnapshotSchema.safeParse({
      ...validSanitized(),
      budget: { tokensTotal: 0, tokensUsed: 0, dollarsTotal: 5, dollarsUsed: 0 },
    });
    expect(r.success).toBe(false);
  });

  it('rejects a leaked recentMessages array', () => {
    const r = SanitizedSnapshotSchema.safeParse({ ...validSanitized(), recentMessages: [] });
    expect(r.success).toBe(false);
  });

  it('rejects a leaked sessionId', () => {
    const r = SanitizedSnapshotSchema.safeParse({ ...validSanitized(), sessionId: 'internal' });
    expect(r.success).toBe(false);
  });

  it('keeps resumeEnabled (RB1/bug #56) and requires it', () => {
    const ok = SanitizedSnapshotSchema.safeParse({ ...validSanitized(), resumeEnabled: true });
    expect(ok.success).toBe(true);
    const missing = { ...validSanitized() };
    delete (missing as Record<string, unknown>).resumeEnabled;
    expect(SanitizedSnapshotSchema.safeParse(missing).success).toBe(false);
  });
});
