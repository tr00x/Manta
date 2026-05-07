#!/usr/bin/env node
import * as path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBusServer } from '../server';

async function main(): Promise<void> {
  const repoRoot = process.env.MANTA_REPO_ROOT
    ? path.resolve(process.env.MANTA_REPO_ROOT)
    : process.cwd();
  const { server } = await createBusServer({ repoRoot });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Stay alive until stdin closes; the transport signals close on EOF.
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('manta-bus failed to start:', err);
  process.exit(1);
});
