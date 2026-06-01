import { describe, it, expect } from 'vitest';
import {
  CloneIdSchema,
  CloneStateSchema,
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
  CastPolicySchema,
  CloneAssignmentSchema,
  RetaskInputSchema,
  PauseInputSchema,
  ResumeInputSchema,
  FeedbackInputSchema,
  RequestTaskInputSchema,
  EnqueueWorkInputSchema,
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

  it('CloneStateSchema accepts IDLE and WAITING_FOR_TASK', () => {
    expect(CloneStateSchema.safeParse('IDLE').success).toBe(true);
    expect(CloneStateSchema.safeParse('WAITING_FOR_TASK').success).toBe(true);
  });

  it('BroadcastEventTypeSchema accepts new daemon event types', () => {
    expect(BroadcastEventTypeSchema.safeParse('task_complete').success).toBe(true);
    expect(BroadcastEventTypeSchema.safeParse('idle').success).toBe(true);
    expect(BroadcastEventTypeSchema.safeParse('feedback_received').success).toBe(true);
  });

  it('BroadcastEventTypeSchema accepts Wave-2 event types', () => {
    for (const t of ['commit_ready', 'review_complete', 'writer_stuck', 'code_ready', 'tests_ready', 'fuzz_complete', 'docs_ready']) {
      expect(BroadcastEventTypeSchema.safeParse(t).success).toBe(true);
    }
  });

  it('CastPolicySchema defaults session_mode to batch when omitted', () => {
    const result = CastPolicySchema.parse({
      peer_messaging: 'allowed',
      auto_merge_threshold: null,
    });
    expect(result.session_mode).toBe('batch');
  });

  it('CastPolicySchema accepts daemon session_mode', () => {
    const result = CastPolicySchema.parse({
      peer_messaging: 'allowed',
      auto_merge_threshold: null,
      session_mode: 'daemon',
    });
    expect(result.session_mode).toBe('daemon');
  });

  it('RetaskInputSchema parses valid input', () => {
    const result = RetaskInputSchema.safeParse({
      clone_id: 'A',
      new_task: 'fix the performance regression in query builder',
    });
    expect(result.success).toBe(true);
  });

  it('RetaskInputSchema rejects missing new_task', () => {
    expect(RetaskInputSchema.safeParse({ clone_id: 'A' }).success).toBe(false);
  });

  it('RetaskInputSchema accepts optional fields', () => {
    const result = RetaskInputSchema.safeParse({
      clone_id: 'A',
      new_task: 'task',
      new_approach_hint: 'try index',
      new_deadline_ms: 600_000,
      new_scope: { allowed_paths: ['src/'], forbidden_paths: [], max_files_changed: 5 },
    });
    expect(result.success).toBe(true);
  });

  it('PauseInputSchema parses valid input', () => {
    expect(PauseInputSchema.safeParse({ clone_id: 'A', reason: 'waiting for review' }).success).toBe(true);
  });

  it('PauseInputSchema rejects empty reason', () => {
    expect(PauseInputSchema.safeParse({ clone_id: 'A', reason: '' }).success).toBe(false);
  });

  it('ResumeInputSchema parses valid input', () => {
    expect(ResumeInputSchema.safeParse({ clone_id: 'A' }).success).toBe(true);
  });

  it('FeedbackInputSchema parses valid input', () => {
    const result = FeedbackInputSchema.safeParse({
      clone_id: 'A',
      from: 'main',
      feedback: 'your approach misses the edge case in query.ts:42',
      severity: 'correction',
    });
    expect(result.success).toBe(true);
  });

  it('FeedbackInputSchema rejects invalid severity', () => {
    expect(
      FeedbackInputSchema.safeParse({
        clone_id: 'A', from: 'main', feedback: 'x', severity: 'critical',
      }).success,
    ).toBe(false);
  });

  it('RequestTaskInputSchema parses valid input', () => {
    expect(RequestTaskInputSchema.safeParse({ clone_id: 'A' }).success).toBe(true);
  });

  it('EnqueueWorkInputSchema parses valid input', () => {
    const result = EnqueueWorkInputSchema.safeParse({
      cast_id: 'cast-123',
      target_clone_id: 'A',
      prompt: 'Write tests for the new feature',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.priority).toBe('normal');
    }
  });

  it('EnqueueWorkInputSchema accepts high priority', () => {
    const result = EnqueueWorkInputSchema.safeParse({
      cast_id: 'cast-123',
      target_clone_id: 'A',
      prompt: 'urgent fix',
      priority: 'high',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.priority).toBe('high');
    }
  });

  it('EnqueueWorkInputSchema rejects empty prompt', () => {
    expect(
      EnqueueWorkInputSchema.safeParse({
        cast_id: 'cast-123', target_clone_id: 'A', prompt: '',
      }).success,
    ).toBe(false);
  });

  it('CloneAssignmentSchema accepts optional role field', () => {
    const result = CloneAssignmentSchema.parse({
      task: 'implement feature X',
      approach_hint: 'writer',
      role: 'writer',
    });
    expect(result.role).toBe('writer');
  });

  it('CloneAssignmentSchema accepts all Wave-2 roles', () => {
    for (const role of ['writer', 'reviewer', 'coder', 'tester', 'fuzzer', 'documenter']) {
      const result = CloneAssignmentSchema.safeParse({ task: 'x', role });
      expect(result.success).toBe(true);
    }
  });

  it('CloneAssignmentSchema works without role', () => {
    const result = CloneAssignmentSchema.parse({ task: 'implement feature X' });
    expect(result.role).toBeUndefined();
  });

  // Bug #M1: the --print-mode MCP bridge serializes numeric tool args as
  // strings, so a clone calling `manta.claim_work` with timeout_ms: 30000
  // reached the bus as "30000" and a bare z.number() rejected it. The
  // coercibleInt widening parses a clean integer-literal string, leaves real
  // numbers untouched, and still rejects non-numeric garbage.
  describe('bug #M1: numeric MCP args arrive as strings (coercibleInt widening)', () => {
    it('ClaimWorkInputSchema accepts a stringified timeout_ms and coerces to number', () => {
      const r = ClaimWorkInputSchema.safeParse({ clone_id: 'A', item: 'task-1', timeout_ms: '30000' });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.timeout_ms).toBe(30_000);
    });

    it('ClaimWorkInputSchema still accepts a real number (no regression)', () => {
      const r = ClaimWorkInputSchema.safeParse({ clone_id: 'A', item: 'task-1', timeout_ms: 30_000 });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.timeout_ms).toBe(30_000);
    });

    it('ClaimWorkInputSchema still rejects non-numeric / non-positive after coercion', () => {
      expect(ClaimWorkInputSchema.safeParse({ clone_id: 'A', item: 't', timeout_ms: 'abc' }).success).toBe(false);
      expect(ClaimWorkInputSchema.safeParse({ clone_id: 'A', item: 't', timeout_ms: '1.5' }).success).toBe(false);
      expect(ClaimWorkInputSchema.safeParse({ clone_id: 'A', item: 't', timeout_ms: '0' }).success).toBe(false);
      expect(ClaimWorkInputSchema.safeParse({ clone_id: 'A', item: 't', timeout_ms: '-5' }).success).toBe(false);
      expect(ClaimWorkInputSchema.safeParse({ clone_id: 'A', item: 't', timeout_ms: '' }).success).toBe(false);
    });

    it('RegisterInputSchema coerces a stringified parent_pid', () => {
      const r = RegisterInputSchema.safeParse({ clone_id: 'A', mode: 'recon-swarm', parent_pid: '12345', worktree: '/w' });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.parent_pid).toBe(12_345);
    });

    it('TaskContractSchema coerces stringified deadline_ms and max_files_changed', () => {
      const r = TaskContractSchema.safeParse({
        clone_id: 'A',
        mode: 'recon-swarm',
        task: 't',
        scope: { allowed_paths: ['src'], max_files_changed: '5' },
        deadline_ms: '1200000',
      });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.deadline_ms).toBe(1_200_000);
        expect(r.data.scope.max_files_changed).toBe(5);
      }
    });

    it('RetaskInputSchema coerces a stringified new_deadline_ms (optional field)', () => {
      const r = RetaskInputSchema.safeParse({ clone_id: 'A', new_task: 'redo', new_deadline_ms: '900000' });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.new_deadline_ms).toBe(900_000);
    });
  });
});
