import { describe, it, expect } from 'vitest';
import { allocateCloneIds } from '../../src/commands/cast.js';
import { CliError } from '../../src/errors.js';

function fakeRegistry(
  records: Array<{ clone_id: string; state: string }>,
): { list(): Promise<Array<{ clone_id: string; state: string }>> } {
  return { list: async () => records };
}

describe('allocateCloneIds (bug #19 fix)', () => {
  it('returns first N letters when registry is empty', async () => {
    const ids = await allocateCloneIds(fakeRegistry([]), 3);
    expect(ids).toEqual(['A', 'B', 'C']);
  });

  it('skips clone names held by live (non-DEAD) clones', async () => {
    const ids = await allocateCloneIds(
      fakeRegistry([{ clone_id: 'A', state: 'WORKING' }]),
      2,
    );
    expect(ids).toEqual(['B', 'C']);
  });

  it('reuses clone names from DEAD clones', async () => {
    const ids = await allocateCloneIds(
      fakeRegistry([
        { clone_id: 'A', state: 'DEAD' },
        { clone_id: 'B', state: 'DEAD' },
      ]),
      2,
    );
    expect(ids).toEqual(['A', 'B']);
  });

  it('skips multiple live states (STARTING, WORKING, IDLE, WAITING_FOR_TASK, BLOCKED, WINDING_DOWN)', async () => {
    const ids = await allocateCloneIds(
      fakeRegistry([
        { clone_id: 'A', state: 'STARTING' },
        { clone_id: 'B', state: 'WORKING' },
        { clone_id: 'C', state: 'IDLE' },
      ]),
      2,
    );
    expect(ids).toEqual(['D', 'E']);
  });

  it('throws concurrent_cast_limit_reached when not enough slots are free', async () => {
    const promise = allocateCloneIds(
      fakeRegistry([
        { clone_id: 'A', state: 'WORKING' },
        { clone_id: 'B', state: 'WORKING' },
        { clone_id: 'C', state: 'WORKING' },
        { clone_id: 'D', state: 'WORKING' },
      ]),
      2,
    );
    await expect(promise).rejects.toThrow(CliError);
    await expect(promise).rejects.toMatchObject({
      kind: 'concurrent_cast_limit_reached',
      message: expect.stringContaining('only 1 of 5'),
    });
  });

  it('mentions live clone IDs in the error message for diagnosability', async () => {
    const promise = allocateCloneIds(
      fakeRegistry([
        { clone_id: 'A', state: 'WORKING' },
        { clone_id: 'C', state: 'IDLE' },
      ]),
      5,
    );
    await expect(promise).rejects.toMatchObject({
      kind: 'concurrent_cast_limit_reached',
      message: expect.stringMatching(/live: A, C/),
    });
  });

  it('returns all five letters when count=5 and registry is empty', async () => {
    const ids = await allocateCloneIds(fakeRegistry([]), 5);
    expect(ids).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('throws if count exceeds total alphabet even with empty registry', async () => {
    const promise = allocateCloneIds(fakeRegistry([]), 6);
    await expect(promise).rejects.toThrow(CliError);
    await expect(promise).rejects.toMatchObject({
      kind: 'concurrent_cast_limit_reached',
    });
  });
});
