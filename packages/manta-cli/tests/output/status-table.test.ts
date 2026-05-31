import { describe, it, expect } from 'vitest';
import { renderStatusTable } from '../../src/output/status-table.js';
import { defaultThresholds } from '@manta/orchestrator';
import type { CloneRecord, LockLease, WorkClaim } from '@manta/bus';

describe('renderStatusTable', () => {
  it('renders an empty table when no clones', () => {
    const out = renderStatusTable({
      now: 0,
      clones: [],
      locks: [],
      claims: [],
      thresholds: defaultThresholds,
    });
    expect(out).toContain('No active clones');
  });

  it('renders columns for each clone', () => {
    const cloneRecord: CloneRecord = {
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: '/w',
      metadata: {},
      registered_at: 1_000_000,
      last_heartbeat_at: 1_000_050,
      state: 'WORKING',
    };
    const lock: LockLease = {
      owner_clone_id: 'A',
      path: 'src/foo.ts',
      acquired_at: 1_000_000,
      last_heartbeat_at: 1_000_080,
    };
    const claim: WorkClaim = {
      owner_clone_id: 'A',
      item: 'task-1',
      claimed_at: 1_000_000,
      expires_at: 2_000_000,
    };
    const out = renderStatusTable({
      now: 1_000_100,
      clones: [cloneRecord],
      locks: [lock],
      claims: [claim],
      thresholds: defaultThresholds,
    });
    expect(out).toContain('A');
    expect(out).toContain('recon-swarm');
    expect(out).toContain('WORKING');
    expect(out).toContain('src/foo.ts');
    expect(out).toContain('task-1');
  });

  const mkClone = (id: string, state: CloneRecord['state']): CloneRecord => ({
    clone_id: id,
    mode: 'recon-swarm',
    parent_pid: 1,
    worktree: `/w/${id}`,
    metadata: {},
    registered_at: 1_000_000,
    last_heartbeat_at: 1_000_050,
    state,
  });
  const base = { now: 1_000_100, locks: [], claims: [], thresholds: defaultThresholds };

  it('hides settled (DEAD) clones by default and notes how many are hidden (#68)', () => {
    const out = renderStatusTable({
      ...base,
      clones: [mkClone('A', 'WORKING'), mkClone('B', 'DEAD'), mkClone('C', 'DEAD')],
    });
    expect(out).toContain('A'); // live shown
    expect(out).not.toContain('| DEAD'); // dead rows hidden
    expect(out).toMatch(/2 settled clone\(s\) hidden/);
    expect(out).toContain('--all');
  });

  it('shows DEAD clones when showAll is set', () => {
    const out = renderStatusTable(
      { ...base, clones: [mkClone('A', 'WORKING'), mkClone('B', 'DEAD')] },
      { showAll: true },
    );
    expect(out).toContain('DEAD');
    expect(out).not.toMatch(/settled clone\(s\) hidden/); // nothing hidden when showing all
  });

  it('reports no active clones (with hidden count) when only DEAD remain', () => {
    const out = renderStatusTable({ ...base, clones: [mkClone('A', 'DEAD'), mkClone('B', 'DEAD')] });
    expect(out).toContain('No active clones');
    expect(out).toMatch(/2 settled clone\(s\) hidden/);
  });
});
