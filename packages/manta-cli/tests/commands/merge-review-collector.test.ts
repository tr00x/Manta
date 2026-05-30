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

const { createMetricCollector, prepareWorktreeForGate } = await import(
  '../../src/commands/merge-review-collector.js'
);

function flatten(): string[] {
  return execaCalls.map((c) => `${c.cmd} ${c.args.join(' ')}`);
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
