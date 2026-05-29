import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import {
  selectCloneRunner,
  runClaudeCli,
  type CloneRunner,
  type CloneRunnerInput,
} from '../../src/spawner/clone-spawner.js';

/**
 * RB1 Chunk 3 — per-clone runner selection (Decision #2). When the snapshot
 * carries `resumeEnabled && forkedSessionId`, the cast path must pick the
 * RESUME runner (`runClaudeResume`) so the clone boots as a continuation of
 * the forked parent transcript; otherwise it must fall back to today's
 * `runClaudeCli` byte-identically (zero regression).
 *
 * The fake fallback runner is a DI seam (NOT a mock of a prod service, NOT an
 * env switch) — it captures `run()` input and proves the fallback is invoked
 * unchanged when not resuming. argv is captured via execa's `spawnargs`.
 */

const FORK_ID = '7b3e1a2c-0000-4abc-8def-1234567890ab';
const PRIMING = 'PRIMING_PREAMBLE_TEXT';
const PROMPT = 'INITIAL_TASK_PROMPT';

function neverRunner(label: string): CloneRunner {
  return {
    run(): never {
      throw new Error(`${label} runner must not be invoked`);
    },
  };
}

describe('selectCloneRunner (RB1 Chunk 3)', () => {
  it('resumeEnabled && forkedSessionId → resume runner, EXACT argv ordering', async () => {
    const runner = selectCloneRunner({
      resumeEnabled: true,
      forkedSessionId: FORK_ID,
      fallback: neverRunner('fallback'),
      claudeBin: '/usr/bin/echo',
    });
    const proc = runner.run({
      cwd: '/tmp',
      env: {},
      appendSystemPrompt: PRIMING,
      prompt: PROMPT,
    });
    // spawnargs[0] is the binary; the rest is the argv we pin.
    expect(proc.spawnargs.slice(1)).toEqual([
      '--print',
      '--resume',
      FORK_ID,
      '--append-system-prompt',
      PRIMING,
      '--permission-mode',
      'bypassPermissions',
      PROMPT,
    ]);
    await proc;
  });

  it('!resumeEnabled → returns the SAME fallback runner (zero regression), captures run input', async () => {
    let captured: CloneRunnerInput | undefined;
    const fallback: CloneRunner = {
      run(input) {
        captured = input;
        return execa(process.execPath, ['-e', 'process.exit(0)'], { reject: false });
      },
    };
    const runner = selectCloneRunner({
      resumeEnabled: false,
      forkedSessionId: undefined,
      fallback,
    });
    // Same object reference — selection adds nothing on the no-resume path.
    expect(runner).toBe(fallback);
    const proc = runner.run({
      cwd: '/tmp',
      env: {},
      appendSystemPrompt: 'p',
      prompt: 't',
    });
    await proc;
    expect(captured).toMatchObject({ appendSystemPrompt: 'p', prompt: 't' });
  });

  it('resumeEnabled but forkedSessionId undefined → falls back (defensive; never resume without a fork)', () => {
    const fallback = neverRunner('fallback');
    const runner = selectCloneRunner({
      resumeEnabled: true,
      forkedSessionId: undefined,
      fallback,
    });
    expect(runner).toBe(fallback);
  });

  it("today's runClaudeCli argv has NO --resume — byte-identical to current behavior", async () => {
    // Pins the non-resume argv against the documented current shape so the
    // resume path provably does not regress the fallback. Mirrors the
    // expectation in clone-spawner.test.ts (the existing spawner suite).
    const cli = runClaudeCli({ claudeBin: '/usr/bin/echo' });
    const proc = cli.run({
      cwd: '/tmp',
      env: {},
      appendSystemPrompt: PRIMING,
      prompt: PROMPT,
    });
    expect(proc.spawnargs.slice(1)).toEqual([
      '--print',
      '--append-system-prompt',
      PRIMING,
      '--permission-mode',
      'bypassPermissions',
      PROMPT,
    ]);
    expect(proc.spawnargs).not.toContain('--resume');
    await proc;
  });
});
