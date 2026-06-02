import { describe, it, expect } from 'vitest';
import { diagnoseCastPreconditions, type PreflightCloneRecord } from '../../src/commands/cast-preflight.js';

// #M14 follow-up: a cast that won't start because slots are occupied must tell
// the operator WHY — orphaned zombies (recover) vs a live concurrent cast (wait)
// — instead of an opaque "cannot allocate N slots".
const rec = (clone_id: string, state: string, parent_pid: number): PreflightCloneRecord => ({
  clone_id,
  state,
  parent_pid,
});

describe('diagnoseCastPreconditions (#M14 "why did my cast crash?")', () => {
  it('clean registry (all DEAD or empty) → no message', () => {
    const v = diagnoseCastPreconditions([rec('A', 'DEAD', 1), rec('B', 'DEAD', 2)], () => true);
    expect(v.message).toBeNull();
    expect(v.orphaned).toEqual([]);
    expect(v.liveConcurrent).toEqual([]);
  });

  it('non-DEAD clone whose parent is GONE → orphaned, recoverable, points at `manta recover`', () => {
    const v = diagnoseCastPreconditions([rec('A', 'WORKING', 999), rec('B', 'STARTING', 999)], () => false);
    expect(v.recoverable).toBe(true);
    expect(v.orphaned.map((r) => r.clone_id)).toEqual(['A', 'B']);
    expect(v.liveConcurrent).toEqual([]);
    expect(v.message).toMatch(/manta recover/);
    expect(v.message).toMatch(/orphaned/);
  });

  it('non-DEAD clone whose parent is ALIVE → live concurrent, NOT recoverable, says wait/abort', () => {
    const v = diagnoseCastPreconditions([rec('A', 'WORKING', 1234)], () => true);
    expect(v.recoverable).toBe(false);
    expect(v.liveConcurrent.map((r) => r.clone_id)).toEqual(['A']);
    expect(v.message).toMatch(/SERIALLY|manta abort|wait/);
  });

  it('mixed: a live cast + an orphan → reports the live one as blocking (recover alone is insufficient)', () => {
    const v = diagnoseCastPreconditions(
      [rec('A', 'WORKING', 1234), rec('B', 'STARTING', 999)],
      (pid) => pid === 1234, // only A's parent alive
    );
    expect(v.recoverable).toBe(false);
    expect(v.liveConcurrent.map((r) => r.clone_id)).toEqual(['A']);
    expect(v.orphaned.map((r) => r.clone_id)).toEqual(['B']);
    expect(v.message).toMatch(/already running/);
    expect(v.message).toMatch(/orphaned/);
  });

  it('DEAD records never count as occupying, regardless of parent liveness', () => {
    const v = diagnoseCastPreconditions([rec('A', 'DEAD', 1234)], () => true);
    expect(v.message).toBeNull();
  });
});
