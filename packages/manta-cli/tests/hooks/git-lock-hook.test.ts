import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkGitLock } from '../../src/hooks/git-lock-hook';

describe('gitLockHook', () => {
  let tmpDir: string;
  let locksPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-git-lock-'));
    locksPath = path.join(tmpDir, 'locks.json');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('blocks git commit when GIT_OPERATIONS lock not held', async () => {
    await fs.writeFile(locksPath, JSON.stringify({ version: 1, leases: {} }));
    const result = await checkGitLock({
      tool: 'Bash',
      input: { command: 'git add . && git commit -m "test"' },
      cloneId: 'A',
      locksPath,
    });
    expect(result.blocked).toBe(true);
    expect(result.message).toContain('GIT_OPERATIONS');
  });

  it('blocks git checkout when lock not held', async () => {
    await fs.writeFile(locksPath, JSON.stringify({ version: 1, leases: {} }));
    const result = await checkGitLock({
      tool: 'Bash',
      input: { command: 'git checkout -b new-branch' },
      cloneId: 'A',
      locksPath,
    });
    expect(result.blocked).toBe(true);
  });

  it('blocks git merge when lock not held', async () => {
    await fs.writeFile(locksPath, JSON.stringify({ version: 1, leases: {} }));
    const result = await checkGitLock({
      tool: 'Bash',
      input: { command: 'git merge feature' },
      cloneId: 'A',
      locksPath,
    });
    expect(result.blocked).toBe(true);
  });

  it('allows git commands when GIT_OPERATIONS lock held by this clone', async () => {
    const locks = {
      version: 1,
      leases: {
        GIT_OPERATIONS: {
          path: 'GIT_OPERATIONS',
          owner_clone_id: 'A',
          acquired_at: 1000,
          last_heartbeat_at: 2000,
        },
      },
    };
    await fs.writeFile(locksPath, JSON.stringify(locks));
    const result = await checkGitLock({
      tool: 'Bash',
      input: { command: 'git commit -m "test"' },
      cloneId: 'A',
      locksPath,
    });
    expect(result.blocked).toBe(false);
  });

  it('blocks git commands when lock held by different clone', async () => {
    const locks = {
      version: 1,
      leases: {
        GIT_OPERATIONS: {
          path: 'GIT_OPERATIONS',
          owner_clone_id: 'B',
          acquired_at: 1000,
          last_heartbeat_at: 2000,
        },
      },
    };
    await fs.writeFile(locksPath, JSON.stringify(locks));
    const result = await checkGitLock({
      tool: 'Bash',
      input: { command: 'git add src/x.ts' },
      cloneId: 'A',
      locksPath,
    });
    expect(result.blocked).toBe(true);
    expect(result.message).toContain('held by B');
  });

  it('allows non-git Bash commands without lock', async () => {
    await fs.writeFile(locksPath, JSON.stringify({ version: 1, leases: {} }));
    const result = await checkGitLock({
      tool: 'Bash',
      input: { command: 'pnpm test' },
      cloneId: 'A',
      locksPath,
    });
    expect(result.blocked).toBe(false);
  });

  it('allows read-only git commands without lock', async () => {
    await fs.writeFile(locksPath, JSON.stringify({ version: 1, leases: {} }));
    const result = await checkGitLock({
      tool: 'Bash',
      input: { command: 'git status' },
      cloneId: 'A',
      locksPath,
    });
    expect(result.blocked).toBe(false);
  });

  it('allows git diff and git log without lock', async () => {
    await fs.writeFile(locksPath, JSON.stringify({ version: 1, leases: {} }));
    const diff = await checkGitLock({
      tool: 'Bash',
      input: { command: 'git diff HEAD' },
      cloneId: 'A',
      locksPath,
    });
    const log = await checkGitLock({
      tool: 'Bash',
      input: { command: 'git log --oneline -5' },
      cloneId: 'A',
      locksPath,
    });
    expect(diff.blocked).toBe(false);
    expect(log.blocked).toBe(false);
  });

  it('passes through non-Bash tools', async () => {
    const result = await checkGitLock({
      tool: 'Read',
      input: { command: 'git commit -m "test"' },
      cloneId: 'A',
      locksPath,
    });
    expect(result.blocked).toBe(false);
  });

  it('handles missing locks.json gracefully (no lock held)', async () => {
    const result = await checkGitLock({
      tool: 'Bash',
      input: { command: 'git commit -m "test"' },
      cloneId: 'A',
      locksPath: path.join(tmpDir, 'nonexistent.json'),
    });
    expect(result.blocked).toBe(true);
  });
});
