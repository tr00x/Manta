import { describe, it, expect } from 'vitest';
import { renderInspect, type InspectOutput } from '../../src/output/inspect-renderer.js';

function makeData(overrides: Partial<InspectOutput> = {}): InspectOutput {
  const now = Date.now();
  return {
    clone: {
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: '/tmp/wt-A',
      metadata: {},
      registered_at: now - 60_000,
      last_heartbeat_at: now - 5_000,
      state: 'WORKING',
    },
    contract: {
      contract: {
        clone_id: 'A',
        mode: 'recon-swarm',
        task: 'Research the codebase',
        scope: { allowed_paths: ['.'], forbidden_paths: ['.manta/state'], max_files_changed: 5 },
        sibling_clones: ['B'],
        deadline_ms: 300_000,
      },
      written_at: now - 50_000,
    },
    locks: [],
    claims: [],
    recentEvents: [
      { id: 'e1', ts: now - 10_000, type: 'heartbeat', clone_id: 'A', payload: { state: 'WORKING' } },
    ],
    liveness: { heartbeatAgeMs: 5_000, stale: false, thresholdMs: 90_000 },
    ...overrides,
  };
}

describe('renderInspect', () => {
  it('renders all sections for a populated clone', () => {
    const out = renderInspect(makeData());
    expect(out).toContain('Clone A — WORKING');
    expect(out).toContain('Identity');
    expect(out).toContain('recon-swarm');
    expect(out).toContain('Contract');
    expect(out).toContain('Research the codebase');
    expect(out).toContain('Recent events');
    expect(out).toContain('heartbeat');
  });

  it('renders DEAD clone with death_reason and died_at', () => {
    const now = Date.now();
    const out = renderInspect(makeData({
      clone: {
        clone_id: 'B',
        mode: 'recon-swarm',
        parent_pid: 1,
        worktree: '/tmp/wt-B',
        metadata: {},
        registered_at: now - 120_000,
        last_heartbeat_at: now - 60_000,
        state: 'DEAD',
        death_reason: 'budget_exceeded',
        died_at: now - 30_000,
      },
    }));
    expect(out).toContain('Clone B — DEAD');
    expect(out).toContain('budget_exceeded');
    expect(out).toContain('died_at');
  });

  it('renders "(not yet written)" for null contract', () => {
    const out = renderInspect(makeData({ contract: null }));
    expect(out).toContain('(not yet written)');
  });

  it('renders "(no events)" for empty events', () => {
    const out = renderInspect(makeData({ recentEvents: [] }));
    expect(out).toContain('(no events)');
  });

  it('truncates long task text at 120 chars', () => {
    const longTask = 'x'.repeat(200);
    const out = renderInspect(makeData({
      contract: {
        contract: {
          clone_id: 'A',
          mode: 'recon-swarm',
          task: longTask,
          scope: { allowed_paths: ['.'], forbidden_paths: [], max_files_changed: 0 },
          sibling_clones: [],
          deadline_ms: 300_000,
        },
        written_at: Date.now(),
      },
    }));
    expect(out).toContain('...');
    expect(out).not.toContain(longTask);
  });

  it('renders locks and claims when present', () => {
    const now = Date.now();
    const out = renderInspect(makeData({
      locks: [{
        path: 'src/index.ts',
        owner_clone_id: 'A',
        acquired_at: now - 20_000,
        last_heartbeat_at: now - 3_000,
      }],
      claims: [{
        item: 'task-1',
        owner_clone_id: 'A',
        claimed_at: now - 15_000,
        expires_at: now + 60_000,
      }],
    }));
    expect(out).toContain('src/index.ts');
    expect(out).toContain('task-1');
  });
});
