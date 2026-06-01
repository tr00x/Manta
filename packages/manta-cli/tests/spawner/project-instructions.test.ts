import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { propagateProjectInstructions } from '../../src/spawner/project-instructions.js';

describe('propagateProjectInstructions', () => {
  let base: string;
  let parent: string;
  let worktree: string;

  beforeEach(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-pi-'));
    parent = path.join(base, 'parent');
    worktree = path.join(base, 'worktree');
    await fs.mkdir(parent, { recursive: true });
    await fs.mkdir(worktree, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  it('copies an untracked CLAUDE.md into a worktree that lacks it', async () => {
    await fs.writeFile(path.join(parent, 'CLAUDE.md'), 'project rules');
    const copied = await propagateProjectInstructions({ parentRoot: parent, worktreePath: worktree });
    expect(copied).toEqual(['CLAUDE.md']);
    expect(await fs.readFile(path.join(worktree, 'CLAUDE.md'), 'utf8')).toBe('project rules');
  });

  it('copies both CLAUDE.md and CLAUDE.local.md when both are absent in the worktree', async () => {
    await fs.writeFile(path.join(parent, 'CLAUDE.md'), 'rules');
    await fs.writeFile(path.join(parent, 'CLAUDE.local.md'), 'local rules');
    const copied = await propagateProjectInstructions({ parentRoot: parent, worktreePath: worktree });
    expect([...copied].sort()).toEqual(['CLAUDE.local.md', 'CLAUDE.md']);
    expect(await fs.readFile(path.join(worktree, 'CLAUDE.local.md'), 'utf8')).toBe('local rules');
  });

  it('does NOT overwrite a CLAUDE.md already present in the worktree (tracked case)', async () => {
    await fs.writeFile(path.join(parent, 'CLAUDE.md'), 'parent version');
    await fs.writeFile(path.join(worktree, 'CLAUDE.md'), 'branch version');
    const copied = await propagateProjectInstructions({ parentRoot: parent, worktreePath: worktree });
    expect(copied).toEqual([]);
    expect(await fs.readFile(path.join(worktree, 'CLAUDE.md'), 'utf8')).toBe('branch version');
  });

  it('is a no-op when the parent has no instruction files', async () => {
    const copied = await propagateProjectInstructions({ parentRoot: parent, worktreePath: worktree });
    expect(copied).toEqual([]);
  });

  it('copies content following a symlinked source, byte-identically, as a real file', async () => {
    const real = path.join(parent, 'real-claude.md');
    await fs.writeFile(real, 'via symlink');
    await fs.symlink(real, path.join(parent, 'CLAUDE.md'));
    const copied = await propagateProjectInstructions({ parentRoot: parent, worktreePath: worktree });
    expect(copied).toEqual(['CLAUDE.md']);
    expect(await fs.readFile(path.join(worktree, 'CLAUDE.md'), 'utf8')).toBe('via symlink');
    const st = await fs.lstat(path.join(worktree, 'CLAUDE.md'));
    expect(st.isSymbolicLink()).toBe(false);
  });
});
