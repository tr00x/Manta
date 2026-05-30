import { execa } from 'execa';
import { CliError } from '../errors.js';

/**
 * Narrow result shape we depend on (a structural subset of ExecaReturnValue).
 * Decoupled from execa's full generic type so test stubs can satisfy this
 * without constructing a Buffer-typed payload.
 */
export interface ClaudeMcpResult {
  exitCode: number | null | undefined;
  stdout: string;
  stderr: string;
  /** execa sets this when the child is killed by the `timeout` option. */
  timedOut?: boolean;
}

export type ClaudeMcpRunner = () => Promise<ClaudeMcpResult>;

export interface VerifyMantaBusRegisteredOptions {
  /**
   * Injection seam for tests. Production wires `claude mcp get manta-bus` via
   * execa; tests stub the result so they don't depend on a real `claude` binary.
   */
  runner?: ClaudeMcpRunner;
}

const PREFLIGHT_TIMEOUT_MS = 15_000;

/**
 * Probe one server by name rather than `claude mcp list`. `list` health-checks
 * EVERY registered server serially, so its latency is hostage to unrelated slow
 * or failing servers (HTTP servers that can't connect, npx/uvx cold starts) — a
 * cast aborted at spawn once because that sweep blew past the 10s timeout while
 * only manta-bus mattered (bug #57). `claude mcp get manta-bus` health-checks
 * solely the server we care about: ~1s locally, independent of the rest.
 */
const defaultRunner: ClaudeMcpRunner = () =>
  execa('claude', ['mcp', 'get', 'manta-bus'], {
    reject: false,
    timeout: PREFLIGHT_TIMEOUT_MS,
  });

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
  let result: ClaudeMcpResult;
  try {
    result = await runner();
  } catch (err) {
    throw new CliError(
      'cannot run `claude mcp get manta-bus` — is the claude CLI on PATH?',
      { kind: 'spawn_failed', cause: err },
    );
  }
  if (result.timedOut) {
    throw new CliError(
      `\`claude mcp get manta-bus\` timed out after ${PREFLIGHT_TIMEOUT_MS}ms — ` +
        'the claude CLI may be hung. Run `claude mcp get manta-bus` manually to diagnose.',
      { kind: 'spawn_failed' },
    );
  }
  // `claude mcp get <name>` exits non-zero ("No MCP server found …") when the
  // server isn't registered — by far the dominant failure here. Surface the
  // raw output for diagnosis alongside the registration fix.
  if (result.exitCode !== 0 || !result.stdout.includes('manta-bus')) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new CliError(
      'manta-bus MCP server is not registered with Claude Code' +
        (detail ? ` (\`claude mcp get manta-bus\` said: ${detail})` : '') +
        '. Run:\n' +
        '  manta install\n' +
        '(self-bootstrap — registers the bus MCP from the installed package). ' +
        'From a source checkout you can instead register it manually:\n' +
        '  claude mcp add -s user manta-bus -- node "$(pwd)/packages/manta-bus/dist/bin/server.cjs"\n' +
        'See docs/user/getting-started.md for full setup.',
      { kind: 'spawn_failed' },
    );
  }
}
