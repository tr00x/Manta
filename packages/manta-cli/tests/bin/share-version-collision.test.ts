import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execa } from 'execa';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// B5 regression against the REAL built bin. The bug is a commander-layer flag
// collision — commander's global `-V/--version` (from program.version()) is
// resolved during parse and intercepts the space-form `--version 1.0.0` on the
// `share` subcommand, printing the CLI version and exiting 0 BEFORE the share
// action runs. A publish command then silently "succeeds" doing nothing. The
// collision only exists at the argv-parsing layer, so the only honest proof is
// to run the bin a user actually gets and inspect stdout/exitCode. Calling
// `runShareCommand` directly (as share.test.ts does) bypasses commander and
// cannot exercise this.
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const builtBin = path.join(pkgRoot, 'dist', 'bin', 'manta.js');

describe('share --pkg-version flag collision (B5) — built bin', () => {
  let tmp: string;

  beforeAll(async () => {
    if (!fs.existsSync(builtBin)) {
      await execa('pnpm', ['run', 'build'], { cwd: pkgRoot });
    }
  }, 180_000);

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'manta-b5-'));
    // createRuntime requires a git-repo marker; a bare `.git` dir suffices
    // (mirrors share.test.ts's fixture). The share action will then run,
    // build its runtime under tmp/.manta/state, and fail on the missing cast.
    await fsp.mkdir(path.join(tmp, '.git'), { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it('`share <castId> --pkg-version 1.0.0` actually invokes the share action (not the global version printer)', async () => {
    const { stdout, stderr, exitCode } = await execa(
      'node',
      [builtBin, 'share', 'cast-9999999999999', '--pkg-version', '1.0.0', '--name', '@manta-library/x'],
      { cwd: tmp, reject: false },
    );
    // The share action ran and reached its own logic: a nonexistent cast is
    // share_cast_not_found (exit 20). The global version printer would instead
    // print "0.1.0" to stdout and exit 0 — that is the silent no-op we fixed.
    expect(exitCode).toBe(20);
    expect(stdout).not.toContain('0.1.0');
    expect(stderr).toContain('share');
    expect(stderr).toContain('share_cast_not_found');
  });

  it('demonstrates the collision the rename fixes: the space-form `--version` still hits the global printer', async () => {
    // This documents WHY `--version` could not be kept (even as an alias): the
    // global `-V/--version` wins at parse time. `--version 1.0.0` prints the
    // CLI version and exits 0; the share action never runs. Pinning this keeps
    // anyone from "helpfully" re-adding a colliding `--version` alias.
    const { stdout, exitCode } = await execa(
      'node',
      [builtBin, 'share', 'cast-9999999999999', '--version', '1.0.0', '--name', '@manta-library/x'],
      { cwd: tmp, reject: false },
    );
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('0.1.0');
  });
});
