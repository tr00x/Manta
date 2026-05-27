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

  it('lists every Manta Bus tool (25 total)', async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'manta.ack_contract',
        'manta.broadcast',
        'manta.claim_work',
        'manta.contract_refresh',
        'manta.drift_report',
        'manta.enqueue_work',
        'manta.feedback',
        'manta.heartbeat',
        'manta.lock',
        'manta.message',
        'manta.para_append',
        'manta.pause',
        'manta.read_broadcasts',
        'manta.register',
        'manta.release_work',
        'manta.renew_lock',
        'manta.report_death',
        'manta.request_task',
        'manta.resume',
        'manta.retask',
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

describe('createBusServer — auto-touch on every successful MCP call (bug #9)', () => {
  // Bug #9 structural fix (option d): the bus dispatcher updates
  // last_heartbeat_at as a side effect of any successful handler whose args
  // include a clone_id, so the orchestrator's death-detector reflects real
  // activity (lock/unlock/zk_write/etc.) without requiring the clone to call
  // manta.heartbeat at any specific cadence. See
  // docs/post-mortems/2026-05-07-cast-1778189501846-validation.md for why
  // skill-level enforcement was insufficient.

  it('non-heartbeat tool call updates last_heartbeat_at via auto-touch', async () => {
    const { root: r, cleanup: clean } = await makeTmpRoot();
    const clock = new FakeClock(1_000_000);
    const { server, context } = await createBusServer({ repoRoot: r, clock });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const client = new Client(
      { name: 'manta-bus-auto-touch', version: '0.0.0' },
      { capabilities: {} },
    );
    await client.connect(c);
    try {
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
      await client.callTool({
        name: 'manta.heartbeat',
        arguments: { clone_id: 'A', state: 'WORKING' },
      });
      const before = await context.registry.get('A');
      expect(before.last_heartbeat_at).toBe(1_000_000);

      // Advance clock far past heartbeatTimeoutMs and make a *non-heartbeat*
      // call. With the auto-touch side effect, last_heartbeat_at must catch up
      // to the new clock — proving any bus call IS a liveness signal.
      clock.advance(120_000);
      const lockResp = await client.callTool({
        name: 'manta.lock',
        arguments: { clone_id: 'A', path: 'docs/example.md' },
      });
      expect(lockResp.isError).toBeFalsy();

      const after = await context.registry.get('A');
      expect(after.last_heartbeat_at).toBe(1_120_000);
      expect(after.state).toBe('WORKING'); // touch never changes state
    } finally {
      await client.close();
      await server.close();
      await clean();
    }
  });

  it('failed tool call does NOT update last_heartbeat_at (auto-touch only on success)', async () => {
    const { root: r, cleanup: clean } = await makeTmpRoot();
    const clock = new FakeClock(1_000_000);
    const { server, context } = await createBusServer({ repoRoot: r, clock });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const client = new Client(
      { name: 'manta-bus-auto-touch-fail', version: '0.0.0' },
      { capabilities: {} },
    );
    await client.connect(c);
    try {
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
      const before = await context.registry.get('A');
      expect(before.last_heartbeat_at).toBe(1_000_000);

      clock.advance(60_000);
      // task_contract.read for a clone that has no contract yet → not_found.
      // Auto-touch must NOT fire on a failed handler — staleness should still
      // be observable to the orchestrator if a clone is only making failing
      // calls.
      const failed = await client.callTool({
        name: 'manta.task_contract.read',
        arguments: { clone_id: 'A' },
      });
      expect(failed.isError).toBe(true);

      const after = await context.registry.get('A');
      expect(after.last_heartbeat_at).toBe(1_000_000); // unchanged
    } finally {
      await client.close();
      await server.close();
      await clean();
    }
  });

  it('auto-touch is a silent no-op on a DEAD clone (death is terminal)', async () => {
    const { root: r, cleanup: clean } = await makeTmpRoot();
    const clock = new FakeClock(1_000_000);
    const { server, context } = await createBusServer({ repoRoot: r, clock });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const client = new Client(
      { name: 'manta-bus-auto-touch-dead', version: '0.0.0' },
      { capabilities: {} },
    );
    await client.connect(c);
    try {
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
      // Mark DEAD via direct registry call (markDead is internal).
      await context.registry.markDead('A', 'killed for test');
      const beforeHeartbeat = (await context.registry.get('A')).last_heartbeat_at;

      // A DEAD clone making a (failed) bus call must NOT have its heartbeat
      // touched — auto-touch's no-op-on-DEAD contract preserves the
      // orchestrator's terminal-state guarantee.
      clock.advance(60_000);
      const resp = await client.callTool({
        name: 'manta.heartbeat',
        arguments: { clone_id: 'A', state: 'WORKING' },
      });
      expect(resp.isError).toBe(true); // heartbeat from DEAD is conflict

      const after = await context.registry.get('A');
      expect(after.state).toBe('DEAD');
      expect(after.last_heartbeat_at).toBe(beforeHeartbeat); // unchanged
    } finally {
      await client.close();
      await server.close();
      await clean();
    }
  });
});

describe('createBusServer — Phase 5 daemon tool dispatch', () => {
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
    client = new Client({ name: 'manta-bus-daemon', version: '0.0.0' }, { capabilities: {} });
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

  async function registerAndWork(cloneId: string): Promise<void> {
    await client.callTool({
      name: 'manta.register',
      arguments: { clone_id: cloneId, mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} },
    });
    await client.callTool({
      name: 'manta.heartbeat',
      arguments: { clone_id: cloneId, state: 'WORKING' },
    });
  }

  it('dispatches manta.retask to lifecycle handler', async () => {
    await registerAndWork('A');
    await client.callTool({
      name: 'manta.heartbeat',
      arguments: { clone_id: 'A', state: 'IDLE' },
    });
    const r = await client.callTool({
      name: 'manta.retask',
      arguments: { clone_id: 'A', new_task: 'fix the bug in query.ts' },
    });
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(readText(r.content)) as { clone: { state: string } };
    expect(parsed.clone.state).toBe('WORKING');
  });

  it('dispatches manta.pause to lifecycle handler', async () => {
    await registerAndWork('A');
    const r = await client.callTool({
      name: 'manta.pause',
      arguments: { clone_id: 'A', reason: 'waiting for review' },
    });
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(readText(r.content)) as { clone: { state: string } };
    expect(parsed.clone.state).toBe('IDLE');
  });

  it('dispatches manta.resume to lifecycle handler', async () => {
    await registerAndWork('A');
    await client.callTool({
      name: 'manta.heartbeat',
      arguments: { clone_id: 'A', state: 'IDLE' },
    });
    const r = await client.callTool({
      name: 'manta.resume',
      arguments: { clone_id: 'A' },
    });
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(readText(r.content)) as { clone: { state: string } };
    expect(parsed.clone.state).toBe('WORKING');
  });

  it('dispatches manta.request_task to lifecycle handler', async () => {
    await registerAndWork('A');
    const r = await client.callTool({
      name: 'manta.request_task',
      arguments: { clone_id: 'A' },
    });
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(readText(r.content)) as { clone: { state: string } };
    expect(parsed.clone.state).toBe('WAITING_FOR_TASK');
  });

  it('dispatches manta.feedback to communication handler', async () => {
    await registerAndWork('A');
    const r = await client.callTool({
      name: 'manta.feedback',
      arguments: { clone_id: 'A', from: 'main', feedback: 'good work on the schema', severity: 'info' },
    });
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(readText(r.content)) as { event: { type: string } };
    expect(parsed.event.type).toBe('feedback');
  });

  it('dispatches manta.enqueue_work to work handler', async () => {
    await registerAndWork('A');
    const r = await client.callTool({
      name: 'manta.enqueue_work',
      arguments: { cast_id: 'cast-123', target_clone_id: 'A', prompt: 'write tests for feature X' },
    });
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(readText(r.content)) as { item: { prompt: string }; event: { type: string } };
    expect(parsed.item.prompt).toBe('write tests for feature X');
    expect(parsed.event.type).toBe('enqueue_work');
  });
});
