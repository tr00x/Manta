import { describe, it, expect } from 'vitest';
import {
  verifyMantaBusRegistered,
  type ClaudeMcpListResult,
} from '../../src/commands/mcp-preflight.js';

const result = (overrides: Partial<ClaudeMcpListResult>): ClaudeMcpListResult => ({
  exitCode: 0,
  stdout: '',
  stderr: '',
  ...overrides,
});

describe('verifyMantaBusRegistered', () => {
  it('passes when stdout contains "manta-bus"', async () => {
    await expect(
      verifyMantaBusRegistered({
        runner: async () =>
          result({ stdout: 'memory: ok\nmanta-bus: registered\n' }),
      }),
    ).resolves.toBeUndefined();
  });

  it('throws spawn_failed when claude exits non-zero', async () => {
    await expect(
      verifyMantaBusRegistered({
        runner: async () => result({ exitCode: 2, stderr: 'claude error' }),
      }),
    ).rejects.toMatchObject({ name: 'CliError', kind: 'spawn_failed' });
  });

  it('throws spawn_failed when manta-bus is missing from stdout', async () => {
    await expect(
      verifyMantaBusRegistered({
        runner: async () => result({ stdout: 'memory: ok\n' }),
      }),
    ).rejects.toMatchObject({
      name: 'CliError',
      kind: 'spawn_failed',
      message: expect.stringContaining('manta-bus'),
    });
  });

  it('throws spawn_failed when the runner itself rejects (claude not on PATH)', async () => {
    await expect(
      verifyMantaBusRegistered({
        runner: async () => {
          const e = new Error('spawn ENOENT');
          (e as NodeJS.ErrnoException).code = 'ENOENT';
          throw e;
        },
      }),
    ).rejects.toMatchObject({
      name: 'CliError',
      kind: 'spawn_failed',
      message: expect.stringContaining('claude CLI'),
    });
  });
});
