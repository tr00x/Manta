import { describe, it, expect } from 'vitest';
import { classifyCastOutcome } from '../../src/budget/cast-outcome.js';
import type { CloneRecord } from '@manta/bus';

function makeClone(overrides: Partial<CloneRecord> = {}): CloneRecord {
  return {
    clone_id: 'A',
    mode: 'recon-swarm',
    parent_pid: 1234,
    worktree: '/tmp/wt',
    metadata: {},
    registered_at: 1000,
    last_heartbeat_at: 2000,
    state: 'DEAD',
    ...overrides,
  };
}

describe('classifyCastOutcome', () => {
  it('all clones completed normally → SUCCESS', () => {
    const result = classifyCastOutcome({
      clones: [
        makeClone({ death_reason: 'graceful shutdown' }),
        makeClone({ clone_id: 'B', death_reason: 'task completed' }),
      ],
      budgetAborted: false,
    });
    expect(result).toBe('success');
  });

  it('budget abort triggered → FAIL', () => {
    const result = classifyCastOutcome({
      clones: [makeClone()],
      budgetAborted: true,
    });
    expect(result).toBe('fail');
  });

  it('one clone heartbeat timeout → FAIL', () => {
    const result = classifyCastOutcome({
      clones: [
        makeClone({ death_reason: 'heartbeat timeout exceeded' }),
        makeClone({ clone_id: 'B', death_reason: 'graceful shutdown' }),
      ],
      budgetAborted: false,
    });
    expect(result).toBe('fail');
  });

  it('one clone startup grace exceeded → FAIL', () => {
    const result = classifyCastOutcome({
      clones: [
        makeClone({ death_reason: 'startup grace period exceeded' }),
      ],
      budgetAborted: false,
    });
    expect(result).toBe('fail');
  });

  it('all clones manually killed → NEUTRAL', () => {
    const result = classifyCastOutcome({
      clones: [
        makeClone({ death_reason: 'manual kill by operator' }),
        makeClone({ clone_id: 'B', death_reason: 'manual termination' }),
      ],
      budgetAborted: false,
    });
    expect(result).toBe('neutral');
  });

  it('mix: one success, one heartbeat timeout → FAIL', () => {
    const result = classifyCastOutcome({
      clones: [
        makeClone({ death_reason: 'graceful shutdown' }),
        makeClone({ clone_id: 'B', death_reason: 'heartbeat timeout' }),
      ],
      budgetAborted: false,
    });
    expect(result).toBe('fail');
  });

  it('empty clones array → NEUTRAL', () => {
    const result = classifyCastOutcome({
      clones: [],
      budgetAborted: false,
    });
    expect(result).toBe('neutral');
  });

  it('death_reason is undefined → treat as normal completion', () => {
    const result = classifyCastOutcome({
      clones: [makeClone({})],
      budgetAborted: false,
    });
    expect(result).toBe('success');
  });

  it('parent pid dead → FAIL', () => {
    const result = classifyCastOutcome({
      clones: [makeClone({ death_reason: 'parent pid disappeared' })],
      budgetAborted: false,
    });
    expect(result).toBe('fail');
  });
});
