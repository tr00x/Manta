#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBusServer } from '../server';

// Exit codes:
//   0 — clean shutdown (SIGTERM / SIGINT)
//   1 — runtime crash (createBusServer threw, transport failure, etc.)
//   2 — config error (e.g. MANTA_REPO_ROOT missing or not a directory)
const EXIT_OK = 0;
const EXIT_RUNTIME = 1;
const EXIT_CONFIG = 2;

/**
 * Validate the resolved repo root before any MCP setup. A bad path turns the
 * first MCP call into a deep ENOENT mapped to `internal_error`, which leaves
 * operators chasing ghosts. Failing at startup with a clear message is the
 * better signal.
 */
async function validateRepoRoot(repoRoot: string): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(repoRoot);
  } catch {
    process.stderr.write(`manta-bus: MANTA_REPO_ROOT does not exist: ${repoRoot}\n`);
    process.exit(EXIT_CONFIG);
  }
  if (!stat.isDirectory()) {
    process.stderr.write(`manta-bus: MANTA_REPO_ROOT is not a directory: ${repoRoot}\n`);
    process.exit(EXIT_CONFIG);
  }
}

async function main(): Promise<void> {
  const repoRoot = process.env.MANTA_REPO_ROOT
    ? path.resolve(process.env.MANTA_REPO_ROOT)
    : process.cwd();
  await validateRepoRoot(repoRoot);
  const { server } = await createBusServer({ repoRoot });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Stay alive until stdin closes; the transport signals close on EOF.

  // Install signal handlers so a `manta-bus` process under systemd / a
  // Claude Code subprocess group exits cleanly on SIGTERM/SIGINT instead of
  // being SIGKILLed after the grace period. `server.close()` releases the
  // transport and runs `onclose` callbacks.
  let shuttingDown = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`manta-bus: received ${sig}, closing...\n`);
    try {
      await server.close();
    } catch (err) {
      process.stderr.write(`manta-bus: error during close: ${String(err)}\n`);
    }
    process.exit(EXIT_OK);
  };
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('manta-bus failed to start:', err);
  process.exit(EXIT_RUNTIME);
});
