import { describe, it, expect } from 'vitest';
import { captureState } from '../src/capture';
import { SnapshotSchema } from '../src/schema';
import { CURRENT_SCHEMA_VERSION } from '../src/version';

describe('captureState', () => {
  it('returns a snapshot with all required fields populated from input', () => {
    const snap = captureState({
      castId: 'cast-001',
      parentSessionId: 'session-abc',
      parentPid: 99,
      taskContract: {
        cloneId: 'A',
        mode: 'recon-swarm',
        task: 'Map repo',
        scope: { allowedPaths: ['src/'], forbiddenPaths: [], maxFilesChanged: 0 },
        approachHint: null,
        siblingClones: [],
        deadlineSeconds: 1200,
      },
      recentMessages: [],
      activeTodos: [],
      openFiles: [],
      parentWorktree: '/parent',
      cloneWorktree: '/clone-A',
      ttlSeconds: 60,
      siblingCloneIds: [],
    });
    expect(snap.version).toBe(CURRENT_SCHEMA_VERSION);
    expect(snap.castId).toBe('cast-001');
    expect(snap.mode).toBe('recon-swarm');
    expect(snap.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('derives mode from taskContract.mode (single source of truth)', () => {
    const snap = captureState({
      castId: 'c',
      parentSessionId: 's',
      parentPid: 1,
      taskContract: {
        cloneId: 'B',
        mode: 'forking-realities',
        task: 't',
        scope: { allowedPaths: ['src/'], forbiddenPaths: [], maxFilesChanged: 0 },
        approachHint: null,
        siblingClones: [],
        deadlineSeconds: 1,
      },
      recentMessages: [],
      activeTodos: [],
      openFiles: [],
      parentWorktree: '/p',
      cloneWorktree: '/c',
      ttlSeconds: 60,
      siblingCloneIds: [],
    });
    expect(snap.mode).toBe('forking-realities');
  });

  it('produces a value that passes SnapshotSchema validation (no manual validation needed)', () => {
    const snap = captureState({
      castId: 'c',
      parentSessionId: 's',
      parentPid: 1,
      taskContract: {
        cloneId: 'A',
        mode: 'recon-swarm',
        task: 't',
        scope: { allowedPaths: ['src/'], forbiddenPaths: [], maxFilesChanged: 0 },
        approachHint: null,
        siblingClones: [],
        deadlineSeconds: 1,
      },
      recentMessages: [],
      activeTodos: [],
      openFiles: [],
      parentWorktree: '/p',
      cloneWorktree: '/c',
      ttlSeconds: 60,
      siblingCloneIds: [],
    });
    expect(() => SnapshotSchema.parse(snap)).not.toThrow();
  });
});

// RB1 Chunk 1 (bug #56): the snapshot must carry the *real* Claude session uuid
// (or null) plus a `resumeEnabled` flag — never the castId masquerading as a
// session id. These pin Decision #1 of the transcript-inheritance plan.
describe('captureState — parentSessionId + resumeEnabled (RB1 Chunk 1)', () => {
  const baseInput = () => ({
    castId: 'cast-1780067836274',
    parentPid: 1,
    taskContract: {
      cloneId: 'A',
      mode: 'recon-swarm' as const,
      task: 't',
      scope: { allowedPaths: ['src/'], forbiddenPaths: [], maxFilesChanged: 0 },
      approachHint: null,
      siblingClones: [],
      deadlineSeconds: 1,
    },
    recentMessages: [],
    activeTodos: [],
    openFiles: [],
    parentWorktree: '/p',
    cloneWorktree: '/c',
    ttlSeconds: 60,
    siblingCloneIds: [],
  });

  it('round-trips a real session uuid verbatim, DISTINCT from castId', () => {
    const sessionUuid = '550e8400-e29b-41d4-a716-446655440000';
    const snap = captureState({
      ...baseInput(),
      parentSessionId: sessionUuid,
      resumeEnabled: true,
    });
    expect(snap.parentSessionId).toBe(sessionUuid);
    expect(snap.parentSessionId).not.toBe(snap.castId);
    expect(() => SnapshotSchema.parse(snap)).not.toThrow();
  });

  it('round-trips resumeEnabled (true and false)', () => {
    const on = captureState({
      ...baseInput(),
      parentSessionId: '550e8400-e29b-41d4-a716-446655440000',
      resumeEnabled: true,
    });
    expect(on.resumeEnabled).toBe(true);

    const off = captureState({ ...baseInput(), parentSessionId: null, resumeEnabled: false });
    expect(off.resumeEnabled).toBe(false);
    expect(off.parentSessionId).toBeNull();
    expect(() => SnapshotSchema.parse(off)).not.toThrow();
  });

  it('defaults resumeEnabled to false when omitted', () => {
    const snap = captureState({ ...baseInput(), parentSessionId: null });
    expect(snap.resumeEnabled).toBe(false);
  });

  it('the .refine REJECTS resumeEnabled:true with parentSessionId:null', () => {
    const bad = {
      ...captureState({ ...baseInput(), parentSessionId: null, resumeEnabled: false }),
      resumeEnabled: true,
      parentSessionId: null,
    };
    const r = SnapshotSchema.safeParse(bad);
    expect(r.success).toBe(false);
  });
});
