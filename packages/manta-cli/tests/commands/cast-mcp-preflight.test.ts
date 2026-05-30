import { describe, it, expect } from 'vitest';
import {
  verifyMantaBusRegistered,
  type ClaudeMcpResult,
} from '../../src/commands/mcp-preflight.js';

const result = (overrides: Partial<ClaudeMcpResult>): ClaudeMcpResult => ({
  exitCode: 0,
  stdout: '',
  stderr: '',
  ...overrides,
});

describe('verifyMantaBusRegistered', () => {
  it('passes when stdout contains "manta-bus"', async () => {
    await expect(
      verifyMantaBusRegistered({
        runner: () =>
          Promise.resolve(result({ stdout: 'memory: ok\nmanta-bus: registered\n' })),
      }),
    ).resolves.toBeUndefined();
  });

  it('throws spawn_failed when claude exits non-zero', async () => {
    await expect(
      verifyMantaBusRegistered({
        runner: () => Promise.resolve(result({ exitCode: 2, stderr: 'claude error' })),
      }),
    ).rejects.toMatchObject({ name: 'CliError', kind: 'spawn_failed' });
  });

  it('throws spawn_failed when manta-bus is missing from stdout', async () => {
    await expect(
      verifyMantaBusRegistered({
        runner: () => Promise.resolve(result({ stdout: 'memory: ok\n' })),
      }),
    ).rejects.toMatchObject({
      name: 'CliError',
      kind: 'spawn_failed',
      message: expect.stringContaining('manta-bus') as unknown as string,
    });
  });

  it('throws a distinct timeout error when `claude mcp get` is killed by the timeout (bug #57)', async () => {
    await expect(
      verifyMantaBusRegistered({
        // execa with `reject:false` resolves on timeout: exitCode undefined,
        // timedOut true, only the first stdout line captured before the kill.
        runner: () =>
          Promise.resolve(
            result({ exitCode: undefined, stdout: 'Checking MCP server health…', timedOut: true }),
          ),
      }),
    ).rejects.toMatchObject({
      name: 'CliError',
      kind: 'spawn_failed',
      message: expect.stringContaining('timed out') as unknown as string,
    });
  });

  it('throws spawn_failed when the runner itself rejects (claude not on PATH)', async () => {
    await expect(
      verifyMantaBusRegistered({
        runner: () => {
          const e = new Error('spawn ENOENT');
          (e as NodeJS.ErrnoException).code = 'ENOENT';
          return Promise.reject(e);
        },
      }),
    ).rejects.toMatchObject({
      name: 'CliError',
      kind: 'spawn_failed',
      message: expect.stringContaining('claude CLI') as unknown as string,
    });
  });

  it('T6 (M4/B7): the fix string recommends `manta install` + plugin reload, and does NOT point at the nonexistent $(pwd) monorepo path', async () => {
    const err = (await verifyMantaBusRegistered({
      runner: () => Promise.resolve(result({ stdout: 'memory: ok\n' })),
    }).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    const msg = err.message;
    expect(msg).toContain('manta install');
    // B7: the from-source `$(pwd)/packages/manta-bus/dist/bin/server.cjs` path does
    // NOT exist in the published artifact — it must not appear in the user-facing fix.
    expect(msg).not.toContain('$(pwd)');
    // B1: plugin users get the bus automatically; the message must mention the plugin path.
    expect(msg.toLowerCase()).toContain('plugin');
  });

  it('T7 (B1): passes when the bus is registered under the plugin-namespaced name', async () => {
    // The bare `manta-bus` get fails (not found), but `plugin:manta:manta-bus` resolves.
    await expect(
      verifyMantaBusRegistered({
        runner: (name: string) =>
          name === 'plugin:manta:manta-bus'
            ? Promise.resolve(result({ exitCode: 0, stdout: 'plugin:manta:manta-bus: connected\n' }))
            : Promise.resolve(result({ exitCode: 1, stdout: '', stderr: 'No MCP server found' })),
      }),
    ).resolves.toBeUndefined();
  });
});
