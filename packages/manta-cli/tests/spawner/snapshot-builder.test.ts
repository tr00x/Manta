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
    budgetUsd: 5,
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

  it('populates the 4-field Budget shape from budgetUsd', () => {
    const snap = buildCloneSnapshot(baseReq());
    expect(snap.budget.dollarsTotal).toBe(5);
    expect(snap.budget.dollarsUsed).toBe(0);
    expect(snap.budget.tokensTotal).toBe(0);
    expect(snap.budget.tokensUsed).toBe(0);
  });

  it('rejects invalid budget (must be positive)', () => {
    expect(() => buildCloneSnapshot({ ...baseReq(), budgetUsd: 0 })).toThrow();
    expect(() => buildCloneSnapshot({ ...baseReq(), budgetUsd: -1 })).toThrow();
  });

  it('produces a snapshot that survives JSON round-trip without losing fields', () => {
    const snap = buildCloneSnapshot(baseReq());
    const round = JSON.parse(JSON.stringify(snap)) as typeof snap;
    expect(round.taskContract.cloneId).toBe('A');
    expect(round.castId).toBe('cast-1');
    expect(round.budget.dollarsTotal).toBe(5);
  });
});
