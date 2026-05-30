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

export type ClaudeMcpRunner = (serverName: string) => Promise<ClaudeMcpResult>;

/**
 * Candidate names the bus may be registered under, in probe order:
 *  - `manta-bus`             — `manta install` / manual `claude mcp add` (user scope)
 *  - `plugin:manta:manta-bus`— the Claude Code PLUGIN registers it namespaced
 *    (`plugin:<marketplace>:<server>`). bug B1: preflight only probed the bare
 *    name, so EVERY plugin user's cast aborted `spawn_failed` even though the
 *    bus was registered and working under the namespaced name.
 */
export const MANTA_BUS_CANDIDATE_NAMES = ['manta-bus', 'plugin:manta:manta-bus'] as const;

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
const defaultRunner: ClaudeMcpRunner = (serverName: string) =>
  execa('claude', ['mcp', 'get', serverName], {
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
  // Probe each candidate name with the fast per-server `get` (NOT `list`, which
  // health-checks every server serially — bug #57). The bus is registered if ANY
  // candidate resolves cleanly. bug B1: the plugin registers `plugin:manta:manta-bus`.
  let lastDetail = '';
  let timedOut = false;
  for (const name of MANTA_BUS_CANDIDATE_NAMES) {
    let result: ClaudeMcpResult;
    try {
      result = await runner(name);
    } catch (err) {
      // A spawn failure (claude not on PATH) is fatal regardless of name.
      throw new CliError(
        'cannot run `claude mcp get` — is the claude CLI on PATH?',
        { kind: 'spawn_failed', cause: err },
      );
    }
    if (result.timedOut) {
      timedOut = true;
      continue;
    }
    if (result.exitCode === 0 && result.stdout.includes('manta-bus')) {
      return; // registered (under this name) — preflight passes.
    }
    lastDetail = (result.stderr || result.stdout || '').trim();
  }
  if (timedOut) {
    throw new CliError(
      `\`claude mcp get\` timed out after ${PREFLIGHT_TIMEOUT_MS}ms — ` +
        'the claude CLI may be hung. Run `claude mcp get manta-bus` manually to diagnose.',
      { kind: 'spawn_failed' },
    );
  }
  throw new CliError(
    'manta-bus MCP server is not registered with Claude Code' +
      (lastDetail ? ` (\`claude mcp get\` said: ${lastDetail})` : '') +
      '. If you installed the Manta plugin, it registers the bus automatically — ' +
      'reload Claude Code. Otherwise run:\n' +
      '  manta install\n' +
      '(self-bootstrap — registers the bus MCP from the installed package).\n' +
      'See docs/user/getting-started.md for full setup.',
    { kind: 'spawn_failed' },
  );
}
