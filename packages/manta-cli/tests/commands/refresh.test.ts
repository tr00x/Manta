import { describe, it, expect, afterEach } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { runRefreshCommand } from '../../src/commands/refresh.js';
import { createReporter, MemorySink } from '../../src/output/reporter.js';
import { createRuntime } from '../../src/runtime.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';

function makeFakeStdin(responses: string[]): NodeJS.ReadableStream {
  let idx = 0;
  const stream = new Readable({
    read() {
      if (idx < responses.length) {
        this.push(responses[idx++] + '\n');
      } else {
        this.push(null);
      }
    },
  });
  (stream as NodeJS.ReadStream).isTTY = true;
  return stream;
}

function makeNullStdout(): NodeJS.WritableStream {
  return new Writable({ write(_chunk, _enc, cb) { cb(); } });
}

describe('refresh command', () => {
  let fx: RepoFixture | undefined;
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  it('reports no cooldown when none is active', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });
    const sink = new MemorySink();
    const result = await runRefreshCommand(rt, {
      reporter: createReporter({ sink }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('No cooldown active.');
  });

  it('clears cooldown with correct double-confirm', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });

    await rt.ctx.charges.triggerCooldown();
    const before = await rt.ctx.charges.read();
    expect(before.cooldown_until).not.toBeNull();

    const sink = new MemorySink();
    const result = await runRefreshCommand(rt, {
      reporter: createReporter({ sink }),
      stdin: makeFakeStdin(['refresh', 'refresh']),
      stdout: makeNullStdout(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Cooldown cleared');

    const after = await rt.ctx.charges.read();
    expect(after.cooldown_until).toBeNull();
    expect(after.current_charges).toBe(0);
  });

  it('rejects if first confirm is wrong', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });

    await rt.ctx.charges.triggerCooldown();

    const sink = new MemorySink();
    const result = await runRefreshCommand(rt, {
      reporter: createReporter({ sink }),
      stdin: makeFakeStdin(['nope']),
      stdout: makeNullStdout(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('Cancelled.');
  });

  it('rejects non-TTY stdin', async () => {
    fx = await makeRepoFixture();
    const rt = await createRuntime({ repoRoot: fx.root });

    await rt.ctx.charges.triggerCooldown();

    const nonTtyStdin = new Readable({ read() { this.push(null); } });
    const sink = new MemorySink();
    const result = await runRefreshCommand(rt, {
      reporter: createReporter({ sink }),
      stdin: nonTtyStdin,
      stdout: makeNullStdout(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('interactive confirmation');
  });
});
