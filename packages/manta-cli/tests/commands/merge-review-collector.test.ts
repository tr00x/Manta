import { describe, it, expect, beforeEach, vi } from 'vitest';

// bug #63 regression: the merge-scorer's quality gate must reproduce the
// canonical pre-merge `pnpm gate` — install + build the worktree, then run
// `tsc -b` (via `pnpm typecheck`) and `pnpm test`. Before the fix it ran
// `npx tsc --noEmit` + `pnpm -r test` on a fresh, unbuilt worktree, which
// false-negatived every build-before-gate cast (RB2 Chunks 2/3/4). These
// tests mock `execa` so we assert the command sequence the scorer issues,
// without spawning a real multi-minute install/build.

const { execaMock, execaCalls } = vi.hoisted(() => {
  const calls: Array<{ cmd: string; args: readonly string[] }> = [];
  const fn = vi.fn(async (cmd: string, args: readonly string[] = []) => {
    calls.push({ cmd, args });
    // `[]` parses as empty eslint json (0 warnings/errors); exitCode 0 = green.
    return { exitCode: 0, stdout: '[]', stderr: '' };
  });
  return { execaMock: fn, execaCalls: calls };
});

vi.mock('execa', () => ({ execa: execaMock }));

// Bug #M9: the collector now detects the worktree's toolchain (via existsSync on
// marker files) and drives the gate from it. These bug #63 tests use synthetic
// paths like `/wt` that don't exist on disk, so the real detector would return
// `unknown` (no gate commands). Force the pnpm toolchain — Manta's own canonical
// gate — so these tests keep asserting the exact pnpm install/build/test/tsc/lint
// command sequence they were written for. (#M9's own behaviour is covered by
// toolchain.test.ts + scoring.test.ts.)
vi.mock('../../src/commands/toolchain.js', () => ({
  detectToolchain: () => ({
    kind: 'pnpm',
    install: ['pnpm', 'install', '--frozen-lockfile', '--prefer-offline'],
    build: ['pnpm', '-r', '--filter', './packages/*', 'build'],
    test: ['pnpm', 'test'],
    isTypeScript: true,
  }),
}));

const { createMetricCollector, prepareWorktreeForGate } = await import(
  '../../src/commands/merge-review-collector.js'
);

function flatten(): string[] {
  return execaCalls.map((c) => `${c.cmd} ${c.args.join(' ')}`);
}

/**
 * Install a faithful execa mock for the RED-path tests. It mirrors execa's real
 * contract: a non-zero exitCode REJECTS unless the caller passed `reject:false`.
 * This is what lets the RED tests prove the result interpretation — a green-only
 * mock (the previous nayobka, bug #63) could never exercise the failure
 * branches, so inverting `runTests`/`readTscErrors` left the suite green.
 */
function setExeca(
  handler: (
    cmd: string,
    args: readonly string[],
  ) => { exitCode: number; stdout?: string; stderr?: string },
): void {
  execaMock.mockImplementation(
    async (
      cmd: string,
      args: readonly string[] = [],
      opts?: { reject?: boolean },
    ) => {
      execaCalls.push({ cmd, args });
      const r = handler(cmd, args);
      const res = {
        exitCode: r.exitCode,
        stdout: r.stdout ?? '',
        stderr: r.stderr ?? '',
      };
      if (res.exitCode !== 0 && opts?.reject !== false) {
        throw Object.assign(
          new Error(`Command failed (${res.exitCode}): ${cmd} ${args.join(' ')}`),
          res,
        );
      }
      return res;
    },
  );
}

describe('merge-review-collector — bug #63 gate prerequisites', () => {
  beforeEach(() => {
    execaCalls.length = 0;
    // Reset to the default green impl so a per-test override (e.g. the
    // serialization test below) never leaks into sibling tests.
    execaMock.mockImplementation(async (cmd: string, args: readonly string[] = []) => {
      execaCalls.push({ cmd, args });
      return { exitCode: 0, stdout: '[]', stderr: '' };
    });
  });

  it('prepareWorktreeForGate installs deps then builds (install before build)', async () => {
    await prepareWorktreeForGate('/wt');
    const cmds = flatten();

    const installIdx = cmds.findIndex((c) => c.startsWith('pnpm install'));
    const buildIdx = cmds.findIndex((c) => c.includes('build'));

    expect(installIdx, 'pnpm install must run').toBeGreaterThanOrEqual(0);
    expect(buildIdx, 'pnpm build must run').toBeGreaterThanOrEqual(0);
    expect(buildIdx, 'build must come after install').toBeGreaterThan(installIdx);
    expect(cmds[buildIdx]).toContain('--filter');
  });

  it('collect() builds the worktree BEFORE measuring tsc/test', async () => {
    const collector = createMetricCollector();
    await collector.collect('A', '/wt', 'main');
    const cmds = flatten();

    const installIdx = cmds.findIndex((c) => c.startsWith('pnpm install'));
    const buildIdx = cmds.findIndex((c) => c.includes('build'));
    const tscIdx = cmds.findIndex((c) => c.includes('typecheck'));
    const testIdx = cmds.findIndex((c) => c === 'pnpm test' || c.startsWith('pnpm test'));

    expect(installIdx).toBeGreaterThanOrEqual(0);
    expect(buildIdx).toBeGreaterThan(installIdx);
    expect(tscIdx, 'typecheck runs after build').toBeGreaterThan(buildIdx);
    expect(testIdx, 'test runs after build').toBeGreaterThan(buildIdx);
  });

  it('uses canonical `pnpm typecheck` (tsc -b), never build-naive `tsc --noEmit`', async () => {
    const collector = createMetricCollector();
    await collector.collect('A', '/wt', 'main');
    const cmds = flatten();

    expect(cmds.some((c) => c.includes('--noEmit')), 'no tsc --noEmit').toBe(false);
    expect(cmds.some((c) => c.includes('pnpm typecheck')), 'canonical typecheck present').toBe(true);
  });

  it('lints the canonical gate scope (packages/**/src), not a divergent `eslint .`', async () => {
    const collector = createMetricCollector();
    await collector.collect('A', '/wt', 'main');
    const cmds = flatten();

    const eslintCmd = cmds.find((c) => c.includes('eslint'));
    expect(eslintCmd, 'eslint must run').toBeDefined();
    expect(eslintCmd).toContain('packages/**/src/**/*.ts');
    // the old build-naive invocation lint-scoped the whole tree via `eslint .`
    expect(eslintCmd).not.toMatch(/eslint\s+\.\s/);
  });

  it('does not run the test step as a per-package `pnpm -r test` (uses root `pnpm test`)', async () => {
    const collector = createMetricCollector();
    await collector.collect('A', '/wt', 'main');
    const cmds = flatten();

    expect(cmds.some((c) => c.startsWith('pnpm -r test'))).toBe(false);
    expect(cmds.some((c) => c === 'pnpm test')).toBe(true);
  });

  // bug #35 re-exposed: the scorer gates all candidates concurrently, so the
  // install step must be serialized across worktrees to avoid the shared-store race.
  it('install uses --frozen-lockfile so the shared store/lockfile cannot be rewritten (bug #35)', async () => {
    await prepareWorktreeForGate('/wt');
    const installCmd = flatten().find((c) => c.startsWith('pnpm install'));
    expect(installCmd, 'pnpm install must run').toBeDefined();
    expect(installCmd, 'install must be frozen so a warm store is a near-noop').toContain(
      '--frozen-lockfile',
    );
  });

  it('serializes install across concurrent prepareWorktreeForGate calls — no two installs overlap (bug #35)', async () => {
    let active = 0;
    let maxActive = 0;
    execaMock.mockImplementation(async (cmd: string, args: readonly string[] = []) => {
      execaCalls.push({ cmd, args });
      if (cmd === 'pnpm' && args[0] === 'install') {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 15));
        active--;
      }
      return { exitCode: 0, stdout: '[]', stderr: '' };
    });

    // Three candidate gates fired concurrently (mirrors cast.ts Promise.all).
    await Promise.all([
      prepareWorktreeForGate('/wt1'),
      prepareWorktreeForGate('/wt2'),
      prepareWorktreeForGate('/wt3'),
    ]);

    expect(maxActive, 'concurrent pnpm install on the shared store is the bug #35 race').toBe(1);
    expect(
      execaCalls.filter((c) => c.cmd === 'pnpm' && c.args[0] === 'install'),
      'all three candidates still installed',
    ).toHaveLength(3);
  });
});

// bug #63 was the FAKE gate: the green-only execa mock meant the scorer's RED
// branches (non-zero typecheck → tscErrors; failing test → testsPassed=false;
// rejected install) were never exercised — you could invert the result
// interpretation and the suite stayed green. These tests pin the failure
// semantics so a flipped interpretation turns red.
describe('merge-review-collector — RED paths (the bug #63 nayobka)', () => {
  beforeEach(() => {
    execaCalls.length = 0;
  });

  it('counts `error TSxxxx` lines when `pnpm typecheck` fails (tscErrors >= 1)', async () => {
    setExeca((cmd, args) => {
      if (cmd === 'pnpm' && args[0] === 'typecheck') {
        return {
          exitCode: 2,
          stdout:
            'src/a.ts(1,1): error TS2304: Cannot find name x\n' +
            'src/b.ts(2,2): error TS1005: ; expected',
          stderr: '',
        };
      }
      return { exitCode: 0 };
    });

    const metrics = await createMetricCollector().collect('A', '/wt', 'main');

    // Inverting readTscErrors (treating non-zero as 0 errors) MUST turn this red.
    expect(metrics.tscErrors).toBeGreaterThanOrEqual(1);
    expect(metrics.tscErrors).toBe(2);
  });

  it('falls back to tscErrors=1 when typecheck fails with no `error TSxxxx` lines', async () => {
    setExeca((cmd, args) => {
      if (cmd === 'pnpm' && args[0] === 'typecheck') {
        return { exitCode: 1, stdout: 'build pipeline crashed', stderr: 'boom' };
      }
      return { exitCode: 0 };
    });

    const metrics = await createMetricCollector().collect('A', '/wt', 'main');
    expect(metrics.tscErrors).toBe(1);
  });

  it('marks testsPassed=false when `pnpm test` exits non-zero', async () => {
    setExeca((cmd, args) => {
      if (cmd === 'pnpm' && args[0] === 'test') {
        return { exitCode: 1, stdout: '', stderr: '3 failing' };
      }
      return { exitCode: 0 };
    });

    const metrics = await createMetricCollector().collect('A', '/wt', 'main');

    // Inverting runTests (returning true on a throw) MUST turn this red.
    expect(metrics.testsPassed).toBe(false);
  });

  it('keeps testsPassed=true on the green path (guards against an always-false flip)', async () => {
    setExeca(() => ({ exitCode: 0 }));
    const metrics = await createMetricCollector().collect('A', '/wt', 'main');
    expect(metrics.testsPassed).toBe(true);
    expect(metrics.tscErrors).toBe(0);
  });

  it('prepareWorktreeForGate RESOLVES when the install exits non-zero (reject:false safety)', async () => {
    setExeca((cmd, args) => {
      if (cmd === 'pnpm' && args[0] === 'install') {
        return { exitCode: 1, stderr: 'ERR_PNPM_LOCKFILE_OUT_OF_DATE' };
      }
      return { exitCode: 0 };
    });

    // install runs with `reject:false`, so a failing install must NOT throw —
    // the candidate stays in scoring and surfaces as a true-RED tsc/test
    // downstream. Removing `reject:false` (the faithful mock then throws on the
    // non-zero exit) MUST turn this assertion red.
    await expect(prepareWorktreeForGate('/wt-red')).resolves.toBeUndefined();
  });
});
