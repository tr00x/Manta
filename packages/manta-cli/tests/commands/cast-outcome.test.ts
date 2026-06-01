import { describe, it, expect } from 'vitest';
import { classifyCastOutcome } from '../../src/commands/cast-outcome.js';
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
      aborted: false,
    });
    expect(result).toBe('success');
  });

  it('cast aborted → FAIL', () => {
    const result = classifyCastOutcome({
      clones: [makeClone()],
      aborted: true,
    });
    expect(result).toBe('fail');
  });

  it('one clone heartbeat timeout → FAIL', () => {
    const result = classifyCastOutcome({
      clones: [
        makeClone({ death_reason: 'heartbeat timeout exceeded' }),
        makeClone({ clone_id: 'B', death_reason: 'graceful shutdown' }),
      ],
      aborted: false,
    });
    expect(result).toBe('fail');
  });

  it('one clone startup grace exceeded → FAIL', () => {
    const result = classifyCastOutcome({
      clones: [makeClone({ death_reason: 'startup grace period exceeded' })],
      aborted: false,
    });
    expect(result).toBe('fail');
  });

  it('one clone hit the startup hard cap → FAIL', () => {
    const result = classifyCastOutcome({
      clones: [makeClone({ death_reason: 'startup hard cap 1801000ms (stuck in STARTING)' })],
      aborted: false,
    });
    expect(result).toBe('fail');
  });

  it('all clones manually killed → NEUTRAL', () => {
    const result = classifyCastOutcome({
      clones: [
        makeClone({ death_reason: 'manual kill by operator' }),
        makeClone({ clone_id: 'B', death_reason: 'manual termination' }),
      ],
      aborted: false,
    });
    expect(result).toBe('neutral');
  });

  it('mix: one success, one heartbeat timeout → FAIL', () => {
    const result = classifyCastOutcome({
      clones: [
        makeClone({ death_reason: 'graceful shutdown' }),
        makeClone({ clone_id: 'B', death_reason: 'heartbeat timeout' }),
      ],
      aborted: false,
    });
    expect(result).toBe('fail');
  });

  it('empty clones array → NEUTRAL', () => {
    const result = classifyCastOutcome({
      clones: [],
      aborted: false,
    });
    expect(result).toBe('neutral');
  });

  it('death_reason is undefined → treat as normal completion', () => {
    const result = classifyCastOutcome({
      clones: [makeClone({})],
      aborted: false,
    });
    expect(result).toBe('success');
  });

  it('parent pid dead → FAIL', () => {
    const result = classifyCastOutcome({
      clones: [makeClone({ death_reason: 'parent pid disappeared' })],
      aborted: false,
    });
    expect(result).toBe('fail');
  });
});
