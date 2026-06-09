import { describe, it, expect } from 'vitest';
import { reapPids } from '../../src/spawner/reap-pids.js';

function recorder() {
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  return {
    signals,
    kill: (pid: number, signal: NodeJS.Signals) => signals.push({ pid, signal }),
    sleep: async () => {},
    gracefulMs: 0,
    isAlive: () => true, // fake pids are "alive" so the SIGKILL re-probe fires
  };
}

describe('reapPids', () => {
  it('SIGTERMs every target, waits the grace once, then SIGKILLs every target', async () => {
    const rec = recorder();
    const n = await reapPids(
      [
        { pid: 100, group: false },
        { pid: 200, group: false },
      ],
      rec,
    );
    expect(n).toBe(2);
    expect(rec.signals).toEqual([
      { pid: 100, signal: 'SIGTERM' },
      { pid: 200, signal: 'SIGTERM' },
      { pid: 100, signal: 'SIGKILL' },
      { pid: 200, signal: 'SIGKILL' },
    ]);
  });

  it('group:true signals the negative pid (process group); group:false signals the bare pid', async () => {
    const rec = recorder();
    await reapPids(
      [
        { pid: 100, group: true },
        { pid: 200, group: false },
      ],
      rec,
    );
    expect(rec.signals.filter((s) => s.signal === 'SIGTERM')).toEqual([
      { pid: -100, signal: 'SIGTERM' },
      { pid: 200, signal: 'SIGTERM' },
    ]);
  });

  it('falls back from the group to the bare pid when the group signal throws', async () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const kill = (pid: number, signal: NodeJS.Signals) => {
      if (pid < 0) throw new Error('ESRCH'); // not a group leader
      signals.push({ pid, signal });
    };
    await reapPids([{ pid: 100, group: true }], { kill, sleep: async () => {}, gracefulMs: 0, isAlive: () => true });
    expect(signals).toEqual([
      { pid: 100, signal: 'SIGTERM' },
      { pid: 100, signal: 'SIGKILL' },
    ]);
  });

  it('dedupes identical targets and refuses unsafe pids (self, init, <= 1)', async () => {
    const rec = recorder();
    const n = await reapPids(
      [
        { pid: 100, group: false },
        { pid: 100, group: false }, // dup
        { pid: process.pid, group: false }, // self — never kill the operator command
        { pid: 1, group: false }, // init
        { pid: 0, group: false }, // invalid
      ],
      rec,
    );
    expect(n).toBe(1);
    expect(new Set(rec.signals.map((s) => s.pid))).toEqual(new Set([100]));
  });

  it('the same pid as both a group and a bare target are distinct (not deduped)', async () => {
    const rec = recorder();
    const n = await reapPids(
      [
        { pid: 100, group: true },
        { pid: 100, group: false },
      ],
      rec,
    );
    expect(n).toBe(2);
    expect(rec.signals.filter((s) => s.signal === 'SIGTERM')).toEqual([
      { pid: -100, signal: 'SIGTERM' },
      { pid: 100, signal: 'SIGTERM' },
    ]);
  });

  it('swallows kill errors so one dead pid never aborts the reap', async () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const kill = (pid: number, signal: NodeJS.Signals) => {
      if (pid === 100) throw new Error('ESRCH'); // already gone
      signals.push({ pid, signal });
    };
    await expect(
      reapPids(
        [
          { pid: 100, group: false },
          { pid: 200, group: false },
        ],
        { kill, sleep: async () => {}, gracefulMs: 0, isAlive: () => true },
      ),
    ).resolves.toBe(2);
    // 200 still got both signals despite 100 throwing.
    expect(signals).toEqual([
      { pid: 200, signal: 'SIGTERM' },
      { pid: 200, signal: 'SIGKILL' },
    ]);
  });

  it('returns 0 and signals nothing for an empty target list', async () => {
    const rec = recorder();
    expect(await reapPids([], rec)).toBe(0);
    expect(rec.signals).toHaveLength(0);
  });
});
