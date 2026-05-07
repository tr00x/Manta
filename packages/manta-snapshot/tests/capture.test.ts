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
      budget: { tokensTotal: 1, tokensUsed: 0, dollarsTotal: 1, dollarsUsed: 0 },
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
      budget: { tokensTotal: 1, tokensUsed: 0, dollarsTotal: 1, dollarsUsed: 0 },
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
      budget: { tokensTotal: 1, tokensUsed: 0, dollarsTotal: 1, dollarsUsed: 0 },
      ttlSeconds: 60,
      siblingCloneIds: [],
    });
    expect(() => SnapshotSchema.parse(snap)).not.toThrow();
  });
});
