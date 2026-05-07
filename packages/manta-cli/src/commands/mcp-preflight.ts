import { execa } from 'execa';
import { CliError } from '../errors.js';

/**
 * Narrow result shape we depend on (a structural subset of ExecaReturnValue).
 * Decoupled from execa's full generic type so test stubs can satisfy this
 * without constructing a Buffer-typed payload.
 */
export interface ClaudeMcpListResult {
  exitCode: number | null | undefined;
  stdout: string;
  stderr: string;
}

export type ClaudeMcpListRunner = () => Promise<ClaudeMcpListResult>;

export interface VerifyMantaBusRegisteredOptions {
  /**
   * Injection seam for tests. Production wires `claude mcp list` via execa;
   * tests stub the result so they don't depend on a real `claude` binary.
   */
  runner?: ClaudeMcpListRunner;
}

const defaultRunner: ClaudeMcpListRunner = () =>
  execa('claude', ['mcp', 'list'], { reject: false, timeout: 10_000 });

/**
 * Pre-flight check that confirms `manta-bus` is registered as an MCP server
 * with the user's Claude Code session. Without it, `claude --print` clones
 * cannot call the bus tools (`manta.register`, `manta.heartbeat`, …) and the
 * cast times out silently — failing fast at the spawner is dramatically
 * cheaper. See plan preamble lines ~19-21.
 */
export async function verifyMantaBusRegistered(
  opts: VerifyMantaBusRegisteredOptions = {},
): Promise<void> {
  const runner = opts.runner ?? defaultRunner;
  let result;
  try {
    result = await runner();
  } catch (err) {
    throw new CliError(
      'cannot run `claude mcp list` — is the claude CLI on PATH?',
      { kind: 'spawn_failed', cause: err },
    );
  }
  if (result.exitCode !== 0) {
    throw new CliError(
      `\`claude mcp list\` exited ${result.exitCode}: ${result.stderr || result.stdout}`,
      { kind: 'spawn_failed' },
    );
  }
  if (!result.stdout.includes('manta-bus')) {
    throw new CliError(
      'manta-bus MCP server is not registered with Claude Code. Run:\n' +
        '  claude mcp add -s user manta-bus -- node "$(pwd)/packages/manta-bus/dist/bin/server.cjs"\n' +
        'See docs/user/getting-started.md for full setup.',
      { kind: 'spawn_failed' },
    );
  }
}
