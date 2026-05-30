import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { CliError } from '../errors.js';
import type { ClaudeMcpResult } from './mcp-preflight.js';

/**
 * Injection seam for `claude mcp …` invocations. Production wires execa; tests
 * stub it so they never spawn a real `claude` binary or mutate the user's real
 * MCP config. Mirrors `mcp-preflight.ts`'s `ClaudeMcpRunner`, but takes the argv
 * because bootstrap issues several distinct sub-commands (get/remove/add).
 */
export type ClaudeMcpExec = (args: string[]) => Promise<ClaudeMcpResult>;

export interface RunBootstrapOptions {
  /** Override the `claude mcp …` runner (tests inject a spy). */
  exec?: ClaudeMcpExec;
  /** Override how the bus server path is resolved (tests inject a fixed path). */
  serverPathResolver?: () => string;
  /** Re-register even if `manta-bus` is already present (remove → add). */
  force?: boolean;
  /** Compute the path + argv and return without mutating any MCP config. */
  dryRun?: boolean;
  /** Caller emits JSON instead of human text (handled by the CLI layer). */
  json?: boolean;
}

export interface RunBootstrapResult {
  action: 'registered' | 'already-registered' | 'dry-run';
  serverPath: string;
  command: string;
}

const BOOTSTRAP_TIMEOUT_MS = 15_000;

const defaultExec: ClaudeMcpExec = (args) =>
  // Reason: real `claude` invocation — never exercised in unit tests (they inject
  // `exec`), so it is intentionally outside unit coverage.
  /* c8 ignore next */
  execa('claude', args, { reject: false, timeout: BOOTSTRAP_TIMEOUT_MS });

/**
 * Resolve the bundled bus server entry (`server.cjs`).
 *
 * THE CRUX: anchor on THIS module's own runtime location, NEVER `process.cwd()`.
 * After Chunk 2's tsup bundle (`splitting:false`), this module is inlined into
 * the single ESM entry `dist/bin/manta.js`; esbuild leaves `import.meta.url`
 * pointing at that emitted bundle. `package.json` `bin["manta-bus"]` is
 * `./dist/bin/server.cjs`, i.e. a SIBLING of `manta.js` under `dist/bin/`. So the
 * server is always `<dir-of-manta.js>/server.cjs`, regardless of where the user
 * runs `manta install` from. In dev/tests this module is NOT bundled (it runs as
 * `src/commands/bootstrap.ts`), so this default points at a non-existent sibling
 * — which is exactly why the resolver is injectable: tests supply their own.
 */
const defaultServerPathResolver = (): string =>
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'server.cjs');

function detailSuffix(result: ClaudeMcpResult): string {
  const detail = (result.stderr || result.stdout || '').trim();
  return detail ? ` (claude said: ${detail})` : '';
}

async function probeRegistered(exec: ClaudeMcpExec): Promise<boolean> {
  let result: ClaudeMcpResult;
  try {
    result = await exec(['mcp', 'get', 'manta-bus']);
  } catch (err) {
    throw new CliError(
      'cannot run `claude mcp get manta-bus` — is the claude CLI on PATH?',
      { kind: 'spawn_failed', cause: err },
    );
  }
  if (result.timedOut) {
    throw new CliError(
      `\`claude mcp get manta-bus\` timed out after ${BOOTSTRAP_TIMEOUT_MS}ms — ` +
        'the claude CLI may be hung. Run `claude mcp get manta-bus` manually to diagnose.',
      { kind: 'spawn_failed' },
    );
  }
  // `claude mcp get <name>` exits non-zero when the server isn't registered.
  return result.exitCode === 0 && result.stdout.includes('manta-bus');
}

async function execMutating(
  exec: ClaudeMcpExec,
  args: string[],
  failMessage: string,
): Promise<void> {
  let result: ClaudeMcpResult;
  try {
    result = await exec(args);
  } catch (err) {
    throw new CliError(
      'cannot run `claude mcp …` — is the claude CLI on PATH?',
      { kind: 'spawn_failed', cause: err },
    );
  }
  if ((result.exitCode ?? 1) !== 0) {
    throw new CliError(`${failMessage}${detailSuffix(result)}`, { kind: 'register_failed' });
  }
}

/**
 * Idempotently register the `manta-bus` MCP server (user scope) so an external
 * `npx manta install` wires the bus to the server INSIDE the installed package.
 */
export async function runBootstrap(opts: RunBootstrapOptions = {}): Promise<RunBootstrapResult> {
  const exec = opts.exec ?? defaultExec;
  const resolveServerPath = opts.serverPathResolver ?? defaultServerPathResolver;
  const force = opts.force ?? false;
  const dryRun = opts.dryRun ?? false;

  const serverPath = resolveServerPath();
  const addArgs = ['mcp', 'add', '-s', 'user', 'manta-bus', '--', 'node', serverPath];
  const command = `claude ${addArgs.join(' ')}`;

  // Dry-run computes the path + argv only — NO probe, NO mutation. Keeping it
  // exec-free is what lets `manta install --dry-run --json` (the PATH-PROOF) run
  // from any cwd even when `claude` is not on PATH.
  if (dryRun) {
    return { action: 'dry-run', serverPath, command };
  }

  const present = await probeRegistered(exec);

  if (present && !force) {
    return { action: 'already-registered', serverPath, command };
  }

  if (present && force) {
    await execMutating(
      exec,
      ['mcp', 'remove', '-s', 'user', 'manta-bus'],
      'failed to remove the existing manta-bus registration before re-adding',
    );
  }

  await execMutating(exec, addArgs, 'failed to register the manta-bus MCP server');
  return { action: 'registered', serverPath, command };
}

/** Render a {@link RunBootstrapResult} as human-readable CLI output. */
export function formatBootstrapResult(result: RunBootstrapResult): string {
  switch (result.action) {
    case 'registered':
      return [
        'Registered the manta-bus MCP server (user scope).',
        `  server:  ${result.serverPath}`,
        `  command: ${result.command}`,
        'Restart Claude Code (or reload MCP servers) to pick it up.',
      ].join('\n');
    case 'already-registered':
      return [
        'manta-bus MCP server is already registered (user scope) — nothing to do.',
        `  server: ${result.serverPath}`,
        'Re-run `manta install --force` to re-register.',
      ].join('\n');
    case 'dry-run':
      return [
        'Dry-run: would register the manta-bus MCP server (user scope).',
        `  server:  ${result.serverPath}`,
        `  command: ${result.command}`,
      ].join('\n');
  }
}
