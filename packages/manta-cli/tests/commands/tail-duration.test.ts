import { describe, it, expect, vi } from 'vitest';
import { runTailCommand } from '../../src/commands/tail.js';

// H3: the `tail` command used `Math.max(10, Number(opts.duration)) * 1000`,
// which (a) silently clamped any sub-10s duration up to 10s and (b) turned a
// NaN duration into a NaN deadline — and `now() >= NaN` is forever false, so
// the poll loop never terminated and tailed forever. These tests pin the
// boundary: NaN/negative/sub-minimum reject loudly, and a valid duration
// terminates at the deadline.

function makeReporter() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal Reporter stub for a unit test
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
}

function makeRt(clockNow: () => number) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal Runtime stub; only clock/events/registry are touched by the loop
  return {
    repoRoot: '/tmp',
    ctx: {
      clock: { now: clockNow },
      events: { readSince: async () => [] },
      registry: { get: async () => ({ state: 'WORKING' }) },
    },
  } as any;
}

describe('tail --duration validation (H3)', () => {
  it('rejects a NaN duration instead of tailing forever', async () => {
    await expect(
      runTailCommand(makeRt(() => 0), {
        cloneId: 'A',
        durationMs: NaN,
        intervalMs: 1,
        raw: false,
        reporter: makeReporter(),
      }),
    ).rejects.toThrow(/finite/i);
  });

  it('accepts a small positive duration without clamping it (no silent 10s floor in the loop)', async () => {
    // The 10s user minimum lives at the CLI boundary; the loop itself must
    // honour exactly the deadline it is given (here ~3s) and terminate, not
    // clamp it up to 10s.
    let calls = 0;
    const now = (): number => {
      calls += 1;
      return calls <= 2 ? 0 : 10_000_000;
    };
    const result = await runTailCommand(makeRt(now), {
      cloneId: 'A',
      durationMs: 3_000,
      intervalMs: 1,
      raw: false,
      reporter: makeReporter(),
    });
    expect(result.exitCode).toBe(0);
  });

  it('rejects a negative duration', async () => {
    await expect(
      runTailCommand(makeRt(() => 0), {
        cloneId: 'A',
        durationMs: -1_000,
        intervalMs: 1,
        raw: false,
        reporter: makeReporter(),
      }),
    ).rejects.toThrow();
  });

  it('terminates at the deadline for a valid duration', async () => {
    // The clock anchors the deadline at t=1000 (first two now() calls), then
    // jumps far past it from the first in-loop check onward, so the loop must
    // break on its deadline test rather than spinning / sleeping forever.
    let calls = 0;
    const now = (): number => {
      calls += 1;
      return calls <= 2 ? 1_000 : 10_000_000;
    };

    const result = await runTailCommand(makeRt(now), {
      cloneId: 'A',
      durationMs: 10_000,
      intervalMs: 1,
      raw: false,
      reporter: makeReporter(),
    });

    expect(result.exitCode).toBe(0);
  });
});
