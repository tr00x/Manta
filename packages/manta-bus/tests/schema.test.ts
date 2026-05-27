import { describe, it, expect } from 'vitest';
import {
  CloneIdSchema,
  RegisterInputSchema,
  HeartbeatInputSchema,
  TaskContractSchema,
  ClaimWorkInputSchema,
  LockInputSchema,
  BroadcastEventTypeSchema,
  BroadcastInputSchema,
  DriftReportInputSchema,
  ZkWriteInputSchema,
  ParaAppendInputSchema,
} from '../src/schema';

describe('schema', () => {
  it('CloneIdSchema accepts short alphanumerics', () => {
    expect(CloneIdSchema.safeParse('A').success).toBe(true);
    expect(CloneIdSchema.safeParse('clone-1').success).toBe(true);
    expect(CloneIdSchema.safeParse('A_B_2').success).toBe(true);
  });

  it('CloneIdSchema rejects whitespace and slashes', () => {
    expect(CloneIdSchema.safeParse('a b').success).toBe(false);
    expect(CloneIdSchema.safeParse('a/b').success).toBe(false);
    expect(CloneIdSchema.safeParse('').success).toBe(false);
    expect(CloneIdSchema.safeParse('A'.repeat(65)).success).toBe(false);
  });

  it('RegisterInputSchema requires clone_id, mode, parent_pid', () => {
    const ok = RegisterInputSchema.safeParse({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1234,
      worktree: '/tmp/w',
      metadata: { foo: 'bar' },
    });
    expect(ok.success).toBe(true);
  });

  it('HeartbeatInputSchema requires state in enum', () => {
    expect(HeartbeatInputSchema.safeParse({ clone_id: 'A', state: 'WORKING' }).success).toBe(true);
    expect(HeartbeatInputSchema.safeParse({ clone_id: 'A', state: 'DEAD' }).success).toBe(true);
    expect(HeartbeatInputSchema.safeParse({ clone_id: 'A', state: 'BANANA' }).success).toBe(false);
  });

  it('TaskContractSchema enforces non-empty allowed_paths', () => {
    const ok = TaskContractSchema.safeParse({
      clone_id: 'A',
      mode: 'recon-swarm',
      task: 'map the codebase',
      scope: { allowed_paths: ['src/'], forbidden_paths: ['secrets/'], max_files_changed: 0 },
      sibling_clones: [],
      deadline_ms: 1_200_000,
    });
    expect(ok.success).toBe(true);

    const bad = TaskContractSchema.safeParse({
      clone_id: 'A',
      mode: 'recon-swarm',
      task: 'x',
      scope: { allowed_paths: [], forbidden_paths: [], max_files_changed: 0 },
      sibling_clones: [],
      deadline_ms: 1_200_000,
    });
    expect(bad.success).toBe(false);
  });

  it('ClaimWorkInputSchema requires positive timeout', () => {
    expect(ClaimWorkInputSchema.safeParse({ clone_id: 'A', item: 'task-1', timeout_ms: 60_000 }).success).toBe(true);
    expect(ClaimWorkInputSchema.safeParse({ clone_id: 'A', item: 'task-1', timeout_ms: 0 }).success).toBe(false);
    expect(ClaimWorkInputSchema.safeParse({ clone_id: 'A', item: 'task-1', timeout_ms: -1 }).success).toBe(false);
  });

  it('LockInputSchema requires repo-relative path', () => {
    expect(LockInputSchema.safeParse({ clone_id: 'A', path: 'src/foo.ts' }).success).toBe(true);
    expect(LockInputSchema.safeParse({ clone_id: 'A', path: '/abs/path' }).success).toBe(false);
    expect(LockInputSchema.safeParse({ clone_id: 'A', path: '../escape' }).success).toBe(false);
    expect(LockInputSchema.safeParse({ clone_id: 'A', path: '' }).success).toBe(false);
  });

  it('BroadcastEventTypeSchema only accepts breakthrough/blocker/dependency', () => {
    expect(BroadcastEventTypeSchema.safeParse('breakthrough').success).toBe(true);
    expect(BroadcastEventTypeSchema.safeParse('blocker').success).toBe(true);
    expect(BroadcastEventTypeSchema.safeParse('dependency').success).toBe(true);
    expect(BroadcastEventTypeSchema.safeParse('chitchat').success).toBe(false);
  });

  it('BroadcastInputSchema validates payload shape', () => {
    expect(
      BroadcastInputSchema.safeParse({
        clone_id: 'A',
        event_type: 'breakthrough',
        payload: { summary: 'found root cause', evidence: 'file.ts:42' },
      }).success,
    ).toBe(true);
  });

  it('DriftReportInputSchema bounds score 0..1', () => {
    expect(DriftReportInputSchema.safeParse({ clone_id: 'A', score: 0.0, evidence: 'fine' }).success).toBe(true);
    expect(DriftReportInputSchema.safeParse({ clone_id: 'A', score: 1.0, evidence: 'gone' }).success).toBe(true);
    expect(DriftReportInputSchema.safeParse({ clone_id: 'A', score: 1.5, evidence: 'x' }).success).toBe(false);
    expect(DriftReportInputSchema.safeParse({ clone_id: 'A', score: -0.1, evidence: 'x' }).success).toBe(false);
  });

  it('ZkWriteInputSchema requires non-empty content', () => {
    expect(
      ZkWriteInputSchema.safeParse({ clone_id: 'A', title: 'note', content: 'body', tags: ['x'] }).success,
    ).toBe(true);
    expect(ZkWriteInputSchema.safeParse({ clone_id: 'A', title: '', content: 'body', tags: [] }).success).toBe(false);
  });

  it('ZkWriteInputSchema coerces CSV-string tags to array (bug #11)', () => {
    const result = ZkWriteInputSchema.safeParse({
      clone_id: 'A',
      title: 'note',
      content: 'body',
      tags: 'phase-5, daemon, architecture',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tags).toEqual(['phase-5', 'daemon', 'architecture']);
    }
  });

  it('ZkWriteInputSchema coerces single-string tag to array (bug #11)', () => {
    const result = ZkWriteInputSchema.safeParse({
      clone_id: 'A',
      title: 'note',
      content: 'body',
      tags: 'solo-tag',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tags).toEqual(['solo-tag']);
    }
  });

  it('ParaAppendInputSchema validates category enum', () => {
    expect(
      ParaAppendInputSchema.safeParse({ clone_id: 'A', category: 'projects', fact: 'X happened' }).success,
    ).toBe(true);
    expect(
      ParaAppendInputSchema.safeParse({ clone_id: 'A', category: 'wrongcat', fact: 'X' }).success,
    ).toBe(false);
  });
});
