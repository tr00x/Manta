import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { FakeClock } from '../src/clock';
import { createBusServer } from '../src/server';
import { makeTmpRoot } from './helpers/tmpRoot';

interface TextContentBlock {
  type: 'text';
  text: string;
}

function readText(content: unknown): string {
  if (!Array.isArray(content)) {
    throw new Error('expected MCP tool content to be an array');
  }
  for (const block of content) {
    if (block && typeof block === 'object' && (block as TextContentBlock).type === 'text') {
      return (block as TextContentBlock).text;
    }
  }
  throw new Error('no text block in MCP tool content');
}

describe('createBusServer error envelope', () => {
  it('non-bus errors map to internal_error', async () => {
    const { root: r, cleanup: clean } = await makeTmpRoot();
    const clock = new FakeClock(1_000_000);
    const { server } = await createBusServer({
      repoRoot: r,
      clock,
      memoryWriters: {
        zkWrite: () => Promise.reject(new Error('disk full')),
        paraAppend: () => Promise.reject(new Error('disk full')),
      },
    });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const c1 = new Client({ name: 'manta-bus-internal', version: '0.0.0' }, { capabilities: {} });
    await c1.connect(c);
    try {
      const resp = await c1.callTool({
        name: 'manta.zk_write',
        arguments: { clone_id: 'A', title: 't', content: 'x', tags: [] },
      });
      expect(resp.isError).toBe(true);
      const parsed = JSON.parse(readText(resp.content)) as { error: string; message: string };
      expect(parsed.error).toBe('internal_error');
      expect(parsed.message).toBe('disk full');
    } finally {
      await c1.close();
      await server.close();
      await clean();
    }
  });

  it('non-Error throwables fall through to internal_error/unknown', async () => {
    const { root: r, cleanup: clean } = await makeTmpRoot();
    const clock = new FakeClock(1_000_000);
    const { server } = await createBusServer({
      repoRoot: r,
      clock,
      memoryWriters: {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        zkWrite: () => Promise.reject('plain string failure'),
        paraAppend: () => Promise.resolve({ path: '' }),
      },
    });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const c1 = new Client({ name: 'manta-bus-unknown', version: '0.0.0' }, { capabilities: {} });
    await c1.connect(c);
    try {
      const resp = await c1.callTool({
        name: 'manta.zk_write',
        arguments: { clone_id: 'A', title: 't', content: 'x', tags: [] },
      });
      expect(resp.isError).toBe(true);
      const parsed = JSON.parse(readText(resp.content)) as { error: string; message: string };
      expect(parsed.error).toBe('internal_error');
      expect(parsed.message).toBe('unknown');
    } finally {
      await c1.close();
      await server.close();
      await clean();
    }
  });
});

describe('createBusServer', () => {
  let root: string;
  let cleanup: () => Promise<void>;
  let client: Client;
  let serverClose: () => Promise<void>;

  beforeEach(async () => {
    ({ root, cleanup } = await makeTmpRoot());
    const clock = new FakeClock(1_000_000);
    const { server } = await createBusServer({ repoRoot: root, clock });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'manta-bus-test', version: '0.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);
    serverClose = async () => {
      await client.close();
      await server.close();
    };
  });
  afterEach(async () => {
    await serverClose();
    await cleanup();
  });

  it('lists every Manta Bus tool', async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'manta.ack_contract',
        'manta.broadcast',
        'manta.claim_work',
        'manta.contract_refresh',
        'manta.drift_report',
        'manta.heartbeat',
        'manta.lock',
        'manta.message',
        'manta.para_append',
        'manta.register',
        'manta.release_work',
        'manta.renew_lock',
        'manta.report_death',
        'manta.suicide_intent',
        'manta.task_contract.read',
        'manta.task_contract.write',
        'manta.unlock',
        'manta.zk_write',
      ].sort(),
    );
  });

  it('register call returns the new clone record', async () => {
    const r = await client.callTool({
      name: 'manta.register',
      arguments: {
        clone_id: 'A',
        mode: 'recon-swarm',
        parent_pid: 1,
        worktree: '/w',
        metadata: {},
      },
    });
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(readText(r.content)) as { clone: { clone_id: string } };
    expect(parsed.clone.clone_id).toBe('A');
  });

  it('invalid input becomes a tool error response with validation_error envelope', async () => {
    const r = await client.callTool({
      name: 'manta.register',
      arguments: {
        clone_id: 'bad id',
        mode: 'recon-swarm',
        parent_pid: 1,
        worktree: '/w',
        metadata: {},
      },
    });
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(readText(r.content)) as { error: string };
    expect(parsed.error).toBe('validation_error');
  });

  it('unknown tool returns a structured unknown_tool error', async () => {
    const r = await client.callTool({
      name: 'manta.does_not_exist',
      arguments: {},
    });
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(readText(r.content)) as { error: string; name: string };
    expect(parsed.error).toBe('unknown_tool');
    expect(parsed.name).toBe('manta.does_not_exist');
  });

  it('not_found errors map to the not_found envelope', async () => {
    const r = await client.callTool({
      name: 'manta.task_contract.read',
      arguments: { clone_id: 'GHOST' },
    });
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(readText(r.content)) as {
      error: string;
      details: { kind: string; id: string };
    };
    expect(parsed.error).toBe('not_found');
    expect(parsed.details).toMatchObject({ kind: 'contract', id: 'GHOST' });
  });

  it('state errors map to the state_error envelope', async () => {
    // Corrupt the registry file on disk so atomic-fs throws BusStateError on
    // the next read — exercises the BusStateError → state_error mapping.
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    await fs.writeFile(
      path.join(root, '.manta', 'state', 'registry.json'),
      '{ this is not json',
      'utf8',
    );
    const r = await client.callTool({
      name: 'manta.register',
      arguments: {
        clone_id: 'A',
        mode: 'recon-swarm',
        parent_pid: 1,
        worktree: '/w',
        metadata: {},
      },
    });
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(readText(r.content)) as { error: string };
    expect(parsed.error).toBe('state_error');
  });

  it('conflict errors map to the conflict envelope', async () => {
    await client.callTool({
      name: 'manta.register',
      arguments: {
        clone_id: 'A',
        mode: 'recon-swarm',
        parent_pid: 1,
        worktree: '/w',
        metadata: {},
      },
    });
    const r = await client.callTool({
      name: 'manta.register',
      arguments: {
        clone_id: 'A',
        mode: 'recon-swarm',
        parent_pid: 2,
        worktree: '/w',
        metadata: {},
      },
    });
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(readText(r.content)) as { error: string };
    expect(parsed.error).toBe('conflict');
  });
});
