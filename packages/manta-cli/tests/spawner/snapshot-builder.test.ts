import { describe, it, expect } from 'vitest';
import { buildCloneSnapshot, type CloneSpawnRequest } from '../../src/spawner/snapshot-builder.js';

describe('snapshot-builder', () => {
  const baseReq = (): CloneSpawnRequest => ({
    cloneId: 'A',
    mode: 'recon-swarm' as const,
    task: 'map src/',
    scope: { allowedPaths: ['src/'], forbiddenPaths: ['secrets/'], maxFilesChanged: 0 },
    siblingClones: ['B', 'C'],
    deadlineMs: 1_200_000,
    parentWorktree: '/repo',
    cloneWorktree: '/repo/.manta/worktrees/clone-A',
    parentPid: 1234,
    parentSessionId: 'sess-1',
    castId: 'cast-1',
  });

  it('builds a snapshot from a CloneSpawnRequest with the correct top-level shape', () => {
    const snap = buildCloneSnapshot(baseReq());
    // Top-level Snapshot fields per @manta/snapshot.SnapshotSchema
    expect(snap.mode).toBe('recon-swarm');
    expect(snap.castId).toBe('cast-1');
    expect(snap.parentSessionId).toBe('sess-1');
    expect(snap.parentPid).toBe(1234);
    expect(snap.parentWorktree).toBe('/repo');
    expect(snap.cloneWorktree).toBe('/repo/.manta/worktrees/clone-A');
    expect(snap.ttlSeconds).toBe(1_200);
    expect(snap.siblingCloneIds).toEqual(['B', 'C']);
    // Nested taskContract uses snapshot-side camelCase field names.
    expect(snap.taskContract.cloneId).toBe('A');
    expect(snap.taskContract.scope.allowedPaths).toEqual(['src/']);
    expect(snap.taskContract.siblingClones).toEqual(['B', 'C']);
    expect(snap.taskContract.deadlineSeconds).toBe(1_200);
    // Empty work surfaces — Phase 0 spawns clones from a clean transcript
    expect(snap.recentMessages).toEqual([]);
    expect(snap.activeTodos).toEqual([]);
    expect(snap.openFiles).toEqual([]);
  });

  it('produces a snapshot that survives JSON round-trip without losing fields', () => {
    const snap = buildCloneSnapshot(baseReq());
    const round = JSON.parse(JSON.stringify(snap)) as typeof snap;
    expect(round.taskContract.cloneId).toBe('A');
    expect(round.castId).toBe('cast-1');
    expect(round.taskContract.deadlineSeconds).toBe(1_200);
  });
});
