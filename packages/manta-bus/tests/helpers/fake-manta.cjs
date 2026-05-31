#!/usr/bin/env node
'use strict';

/**
 * Stub `manta` CLI binary for user-tools tests. NOT a mock of the spawn itself —
 * a real child process the tests run against, so the production spawn path
 * (resolution → argv → capture/launch) is exercised end to end; only the binary
 * is fake.
 *
 * Behaviour is selected by MANTA_FAKE_MODE:
 *   - unset / 'echo'  : print `{"argv":[…]}` (the args after the script) to
 *                       stdout and exit 0. Lets a test assert argv mapping and
 *                       stdout passthrough, and (because the payload is JSON)
 *                       doubles as the inspect --json fixture.
 *   - 'cast-launched' : write a reporter-style `cast.spawn` line carrying a
 *                       `clone-cast-<ts>-A` worktree path to STDERR (so the tool
 *                       extracts the cast id and declares the cast launched),
 *                       then linger briefly before exiting — simulating a real
 *                       long-running cast the tool must NOT block on.
 */

const argv = process.argv.slice(2);
const mode = process.env.MANTA_FAKE_MODE || 'echo';

if (mode === 'cast-launched') {
  // The real cast emits this on stderr (StderrSink) right after each clone is
  // spawned; the worktree path embeds the internally-generated cast id.
  process.stderr.write(
    '[info] cast.spawn cloneId=A worktree=/tmp/.manta/worktrees/clone-cast-9999999999999-A\n',
  );
  // Stay alive long enough that the tool MUST resolve via the stderr scan, not
  // by waiting for exit. Self-exit so no orphan lingers after the test run.
  setTimeout(() => process.exit(0), 1500);
} else {
  process.stdout.write(JSON.stringify({ argv }) + '\n');
  process.exit(0);
}
