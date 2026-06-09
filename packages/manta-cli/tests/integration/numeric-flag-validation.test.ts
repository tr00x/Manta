import { describe, it, expect, beforeAll } from 'vitest';
import { execa } from 'execa';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * #60 regression — numeric CLI flags reject NaN garbage at the boundary.
 *
 * Before this fix, `replay/tail/audit/inspect` used bare `parseInt` on their
 * numeric flags/args. A non-numeric value parsed to `NaN`, and every downstream
 * use of it failed SILENTLY: `event.ts > NaN` (since-filter) is always false so
 * the command showed nothing; `limit > 0` with `NaN` skipped the slice so it
 * showed everything; `NaN * 1000` collapsed the tail window. A typo disarmed the
 * flag instead of erroring. The fix attaches the NaN-guarding coercers (already
 * used for cast flags) at the commander boundary so a bad value fails LOUD.
 *
 * This drives the REAL built binary (not a source seam) because the wiring under
 * test is exactly "which coercer is bound to which option in `manta.ts`" — only
 * the shipped CLI exercises that. The bin is rebuilt in beforeAll so a stale
 * dist can never green a regressed source.
 */
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bin = path.join(pkgRoot, 'dist', 'bin', 'manta.cjs');

async function run(args: string[]): Promise<{ code: number | undefined; out: string }> {
  const r = await execa('node', [bin, ...args], { reject: false });
  return { code: r.exitCode, out: `${r.stdout}\n${r.stderr}` };
}

describe('#60 numeric flags reject NaN at the CLI boundary (real bin)', () => {
  beforeAll(async () => {
    // Guarantee the dist matches current source — `pnpm test` does not build.
    await execa('pnpm', ['build'], { cwd: pkgRoot });
  }, 180_000);

  it('replay --since abc → loud reject (was: NaN since-filter silently shows nothing)', async () => {
    const { code, out } = await run(['replay', 'somecast', '--since', 'abc']);
    expect(code).not.toBe(0);
    expect(out).toMatch(/non-negative integer/);
  });

  it('audit --limit abc → loud reject (was: NaN limit silently shows everything)', async () => {
    const { code, out } = await run(['audit', 'someclone', '--limit', 'abc']);
    expect(code).not.toBe(0);
    expect(out).toMatch(/positive integer/);
  });

  it('audit --limit 0 → reject the slice(-0) footgun (0 ≠ a real limit)', async () => {
    const { code, out } = await run(['audit', 'someclone', '--limit', '0']);
    expect(code).not.toBe(0);
    expect(out).toMatch(/positive integer/);
  });

  it('audit --gap-threshold xx → loud reject', async () => {
    const { code, out } = await run(['audit', 'someclone', '--gaps', '--gap-threshold', 'xx']);
    expect(code).not.toBe(0);
    expect(out).toMatch(/positive integer/);
  });

  it('tail <positional> abc → loud reject (was: NaN*1000 collapsed the window)', async () => {
    const { code, out } = await run(['tail', 'someclone', 'abc']);
    expect(code).not.toBe(0);
    expect(out).toMatch(/durationSeconds must be a positive integer/);
  });

  it('tail --interval nope → loud reject', async () => {
    const { code, out } = await run(['tail', 'someclone', '--interval', 'nope']);
    expect(code).not.toBe(0);
    expect(out).toMatch(/positive integer/);
  });

  it('inspect --events abc → loud reject', async () => {
    const { code, out } = await run(['inspect', 'someclone', '--events', 'abc']);
    expect(code).not.toBe(0);
    expect(out).toMatch(/positive integer/);
  });

  it('control: a VALID --since 0 passes the coercer (fails later at the runtime layer, not at parse)', async () => {
    const { code, out } = await run(['replay', 'definitely-not-a-real-cast', '--since', '0']);
    expect(code).not.toBe(0); // non-zero, but NOT because the coercer rejected it
    expect(out).not.toMatch(/non-negative integer/); // 0 accepted — no coercer rejection
    // Reached the `[manta]` runtime layer (repo/cast error), past commander's
    // `error: option …` parse rejection — proving 0 is a valid --since value.
    expect(out).toMatch(/\[manta\]/);
  });
});
