import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { forkParentSession, mangle } from '../../src/spawner/session-fork.js';

/**
 * RB1 Chunk 2 — hermetic tests for the parent→clone transcript fork. NO real
 * `claude` binary, NO network: we plant a fixture JSONL under a temp
 * `claudeHome` and assert the copy lands in the clone's mangled project dir
 * with a fresh uuid, the source stays byte-identical, and the size/missing
 * guards skip without writing.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const tmpDirs: string[] = [];
async function makeClaudeHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-fork-test-'));
  tmpDirs.push(dir);
  return dir;
}

/** Plant a parent transcript at <claudeHome>/projects/<mangle(cwd)>/<id>.jsonl. */
async function plantParent(
  claudeHome: string,
  parentCwd: string,
  parentSessionId: string,
  body: string,
): Promise<string> {
  const dir = path.join(claudeHome, 'projects', mangle(parentCwd));
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${parentSessionId}.jsonl`);
  await fs.writeFile(file, body, 'utf8');
  return file;
}

afterEach(async () => {
  await Promise.all(
    tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })),
  );
});

describe('mangle()', () => {
  // The non-existent paths below exercise the catch-fallback (realpathSync
  // throws → literal path), which still applies the char map. Real symlink
  // resolution is covered by its own test further down.
  it('replaces "/" and "." with "-" (Claude Code project-dir scheme)', () => {
    expect(mangle('/Users/me/proj')).toBe('-Users-me-proj');
  });

  it('produces the verified DOUBLE-dash for a leading-dot dir (§2.2)', () => {
    // `/.manta` → the "/" before `.manta` becomes "-" AND the "." becomes "-",
    // yielding "--manta". This is the highest-risk correctness point in RB1:
    // a mismatch writes the fork where `--resume` will never look.
    expect(mangle('/Users/timur/projectos/manta/.manta/worktrees/clone-A')).toBe(
      '-Users-timur-projectos-manta--manta-worktrees-clone-A',
    );
  });

  it('handles a dotfile-only segment and trailing dots', () => {
    expect(mangle('/a/.b/c.d')).toBe('-a--b-c-d');
  });

  it('replaces EVERY non-alphanumeric char (_ space + @), preserving case (bug #61)', () => {
    // The old `/`+`.`-only transform silently PRESERVED `_`, space, `+`, `@`,
    // writing the fork to a dir `claude` (which maps them all to `-`) never
    // uses → silent empty inheritance for any repo path with an underscore.
    expect(mangle('/x/y_z/a b+C@d')).toBe('-x-y-z-a-b-C-d');
  });

  it('resolves symlinks to the real path before mangling (bug #61: /var → /private/var class)', async () => {
    // On macOS os.tmpdir() is itself under /var → /private/var, so resolve the
    // real target first; the assertion then turns purely on the symlink hop.
    const real = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'manta-mangle-real-')));
    tmpDirs.push(real);
    const linkParent = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-mangle-link-'));
    tmpDirs.push(linkParent);
    const link = path.join(linkParent, 'via_link'); // underscore on purpose
    await fs.symlink(real, link);

    // mangle follows the symlink: identical to mangling the real target, and
    // NOT a naive char-replace of the unresolved link path. A `claude --resume`
    // run from `link` lands in the real target's project dir, so the fork must
    // be written there — this is exactly what the prior mangle got wrong.
    expect(mangle(link)).toBe(mangle(real));
    expect(mangle(link)).not.toBe(link.replace(/[^a-zA-Z0-9]/g, '-'));
  });
});

describe('forkParentSession', () => {
  const PARENT_CWD = '/Users/timur/projectos/manta';
  const CLONE_CWD = '/Users/timur/projectos/manta/.manta/worktrees/clone-A';
  const PARENT_ID = '5d6203f6-7d82-4cfc-a66b-90277f4e1d80';
  const BODY = '{"type":"summary"}\n{"type":"user","msg":"hi"}\n';

  it('copies the parent JSONL into the clone projdir under a fresh uuid; source byte-identical', async () => {
    const claudeHome = await makeClaudeHome();
    const srcFile = await plantParent(claudeHome, PARENT_CWD, PARENT_ID, BODY);
    const before = await fs.readFile(srcFile);

    const result = await forkParentSession({
      parentSessionId: PARENT_ID,
      parentCwd: PARENT_CWD,
      cloneCwd: CLONE_CWD,
      claudeHome,
    });

    expect('forkedSessionId' in result).toBe(true);
    const forkedSessionId = (result as { forkedSessionId: string }).forkedSessionId;
    expect(forkedSessionId).toMatch(UUID_RE);
    expect(forkedSessionId).not.toBe(PARENT_ID);

    // Copy landed in the CLONE's project dir (distinct from parent's).
    const cloneDir = path.join(claudeHome, 'projects', mangle(CLONE_CWD));
    const parentDir = path.join(claudeHome, 'projects', mangle(PARENT_CWD));
    expect(cloneDir).not.toBe(parentDir);
    const copyPath = path.join(cloneDir, `${forkedSessionId}.jsonl`);
    const copy = await fs.readFile(copyPath);
    expect(copy.equals(before)).toBe(true);

    // Source byte-identical after the fork (fs.copyFile opens it once for read).
    const after = await fs.readFile(srcFile);
    expect(after.equals(before)).toBe(true);
  });

  it('returns { skipped: "not_found" } and writes nothing when the parent file is missing', async () => {
    const claudeHome = await makeClaudeHome();
    // No plantParent — the source does not exist.
    const result = await forkParentSession({
      parentSessionId: PARENT_ID,
      parentCwd: PARENT_CWD,
      cloneCwd: CLONE_CWD,
      claudeHome,
    });
    expect(result).toEqual({ skipped: 'not_found' });

    // Clone project dir must not have been created.
    const cloneDir = path.join(claudeHome, 'projects', mangle(CLONE_CWD));
    await expect(fs.access(cloneDir)).rejects.toBeDefined();
  });

  it('returns { skipped: "over_threshold" } and writes nothing when the parent exceeds thresholdBytes', async () => {
    const claudeHome = await makeClaudeHome();
    const big = 'x'.repeat(5_000);
    const srcFile = await plantParent(claudeHome, PARENT_CWD, PARENT_ID, big);
    const before = await fs.readFile(srcFile);

    const result = await forkParentSession({
      parentSessionId: PARENT_ID,
      parentCwd: PARENT_CWD,
      cloneCwd: CLONE_CWD,
      claudeHome,
      thresholdBytes: 1_000,
    });
    expect(result).toEqual({ skipped: 'over_threshold' });

    // Nothing written to the clone dir; source untouched.
    const cloneDir = path.join(claudeHome, 'projects', mangle(CLONE_CWD));
    await expect(fs.access(cloneDir)).rejects.toBeDefined();
    expect((await fs.readFile(srcFile)).equals(before)).toBe(true);
  });

  it('does NOT skip a file exactly at the threshold (strictly-greater guard)', async () => {
    const claudeHome = await makeClaudeHome();
    const body = 'y'.repeat(1_000);
    await plantParent(claudeHome, PARENT_CWD, PARENT_ID, body);
    const result = await forkParentSession({
      parentSessionId: PARENT_ID,
      parentCwd: PARENT_CWD,
      cloneCwd: CLONE_CWD,
      claudeHome,
      thresholdBytes: 1_000,
    });
    expect('forkedSessionId' in result).toBe(true);
  });

  it('two concurrent forks from one parent → two distinct files in two distinct dirs; parent byte-identical', async () => {
    const claudeHome = await makeClaudeHome();
    const cloneCwdA = '/Users/timur/projectos/manta/.manta/worktrees/clone-A';
    const cloneCwdB = '/Users/timur/projectos/manta/.manta/worktrees/clone-B';
    const srcFile = await plantParent(claudeHome, PARENT_CWD, PARENT_ID, BODY);
    const before = await fs.readFile(srcFile);

    const [ra, rb] = await Promise.all([
      forkParentSession({ parentSessionId: PARENT_ID, parentCwd: PARENT_CWD, cloneCwd: cloneCwdA, claudeHome }),
      forkParentSession({ parentSessionId: PARENT_ID, parentCwd: PARENT_CWD, cloneCwd: cloneCwdB, claudeHome }),
    ]);

    const idA = (ra as { forkedSessionId: string }).forkedSessionId;
    const idB = (rb as { forkedSessionId: string }).forkedSessionId;
    expect(idA).toMatch(UUID_RE);
    expect(idB).toMatch(UUID_RE);
    expect(idA).not.toBe(idB);

    const dirA = path.join(claudeHome, 'projects', mangle(cloneCwdA));
    const dirB = path.join(claudeHome, 'projects', mangle(cloneCwdB));
    expect(dirA).not.toBe(dirB);
    expect((await fs.readFile(path.join(dirA, `${idA}.jsonl`))).equals(before)).toBe(true);
    expect((await fs.readFile(path.join(dirB, `${idB}.jsonl`))).equals(before)).toBe(true);

    // Parent still byte-identical after two concurrent forks.
    expect((await fs.readFile(srcFile)).equals(before)).toBe(true);
  });

  it('defaults thresholdBytes to 2 MB when omitted (a small file is copied)', async () => {
    const claudeHome = await makeClaudeHome();
    await plantParent(claudeHome, PARENT_CWD, PARENT_ID, BODY);
    const result = await forkParentSession({
      parentSessionId: PARENT_ID,
      parentCwd: PARENT_CWD,
      cloneCwd: CLONE_CWD,
      claudeHome,
    });
    expect('forkedSessionId' in result).toBe(true);
  });
});
