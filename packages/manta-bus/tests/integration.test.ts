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
  if (!Array.isArray(content)) throw new Error('expected MCP content array');
  for (const block of content) {
    if (block && typeof block === 'object' && (block as TextContentBlock).type === 'text') {
      return (block as TextContentBlock).text;
    }
  }
  throw new Error('no text block in MCP content');
}

async function call(client: Client, name: string, args: unknown): Promise<Record<string, unknown>> {
  const r = await client.callTool({ name, arguments: args as Record<string, unknown> });
  if (r.isError) {
    const text = readText(r.content);
    throw new Error(`tool ${name} failed: ${text}`);
  }
  return JSON.parse(readText(r.content)) as Record<string, unknown>;
}

describe('Manta Bus end-to-end (recon-swarm slice)', () => {
  let root: string;
  let cleanup: () => Promise<void>;
  let client: Client;
  let close: () => Promise<void>;
  let clock: FakeClock;

  beforeEach(async () => {
    ({ root, cleanup } = await makeTmpRoot());
    clock = new FakeClock(1_000_000);
    const { server } = await createBusServer({ repoRoot: root, clock, staleLockMs: 15_000 });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    client = new Client({ name: 'manta-bus-it', version: '0.0.0' }, { capabilities: {} });
    await client.connect(c);
    close = async () => {
      await client.close();
      await server.close();
    };
  });
  afterEach(async () => {
    await close();
    await cleanup();
  });

  it('runs the full lifecycle: register → contract → ack → claim → lock → broadcast → release → death', async () => {
    // 1. main writes contract for clone A
    await call(client, 'manta.task_contract.write', {
      contract: {
        clone_id: 'A',
        mode: 'recon-swarm',
        task: 'map src/',
        scope: { allowed_paths: ['src/'], forbidden_paths: [], max_files_changed: 0 },
        sibling_clones: [],
        deadline_ms: 1_200_000,
      },
    });
    // 2. clone A registers
    const reg = (await call(client, 'manta.register', {
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: '/w',
      metadata: {},
    })) as { clone: { state: string } };
    expect(reg.clone.state).toBe('STARTING');
    // 3. clone A acks
    await call(client, 'manta.ack_contract', {
      clone_id: 'A',
      interpretation: 'will only read src/',
    });
    // 4. heartbeat → WORKING
    clock.advance(2_000);
    await call(client, 'manta.heartbeat', { clone_id: 'A', state: 'WORKING' });
    // 5. claim a work item
    const claim = (await call(client, 'manta.claim_work', {
      clone_id: 'A',
      item: 'analyze-routes',
      timeout_ms: 60_000,
    })) as { claim: { owner_clone_id: string } };
    expect(claim.claim.owner_clone_id).toBe('A');
    // 6. acquire a lock
    await call(client, 'manta.lock', { clone_id: 'A', path: 'src/index.ts' });
    // 7. broadcast breakthrough
    await call(client, 'manta.broadcast', {
      clone_id: 'A',
      event_type: 'breakthrough',
      payload: { summary: 'route map ready' },
    });
    // 8. release lock + claim
    await call(client, 'manta.unlock', { clone_id: 'A', path: 'src/index.ts' });
    await call(client, 'manta.release_work', { clone_id: 'A', item: 'analyze-routes' });
    // 9. report death
    const death = (await call(client, 'manta.report_death', {
      clone_id: 'A',
      last_gasp_report_path: '/tmp/last.json',
    })) as { clone: { state: string } };
    expect(death.clone.state).toBe('DEAD');
  });

  // #M11: the dispatch-side BroadcastReader projects each event from its
  // payload ALONE, so the broadcast handler MUST mirror clone_id (and cast_id +
  // event_type) INTO the payload — not only the top-level event field. Before
  // the fix clone_id lived only top-level, BroadcastReader read '' for it, and
  // PairDispatcher/TestStorm never matched the writer's broadcast → the next
  // turn was never enqueued and pair/test-storm stalled after one turn.
  it('broadcast mirrors clone_id + cast_id + event_type into the payload (bug #M11)', async () => {
    await call(client, 'manta.register', {
      clone_id: 'A',
      mode: 'pair-programming',
      parent_pid: 1,
      worktree: '/w',
      metadata: { cast_id: 'cast-x', cast_mode: 'pair-programming', role: 'writer' },
    });
    const res = (await call(client, 'manta.broadcast', {
      clone_id: 'A',
      event_type: 'commit_ready',
      payload: { commit_ref: 'abc123' },
    })) as { event: { clone_id: string; payload: Record<string, unknown> } };
    expect(res.event.payload.clone_id).toBe('A');
    expect(res.event.payload.cast_id).toBe('cast-x');
    expect(res.event.payload.event_type).toBe('commit_ready');
    expect((res.event.payload.body as Record<string, unknown>).commit_ref).toBe('abc123');
  });

  it('rejects scope-conflicting work via BusLockedError surface', async () => {
    await call(client, 'manta.register', {
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: '/w',
      metadata: {},
    });
    await call(client, 'manta.register', {
      clone_id: 'B',
      mode: 'recon-swarm',
      parent_pid: 2,
      worktree: '/w',
      metadata: {},
    });
    await call(client, 'manta.lock', { clone_id: 'A', path: 'src/foo.ts' });
    const err = await client.callTool({
      name: 'manta.lock',
      arguments: { clone_id: 'B', path: 'src/foo.ts' },
    });
    expect(err.isError).toBe(true);
    const parsed = JSON.parse(readText(err.content)) as {
      error: string;
      details: { path: string; ownerCloneId: string };
    };
    expect(parsed.error).toBe('locked');
    expect(parsed.details).toMatchObject({ path: 'src/foo.ts', ownerCloneId: 'A' });
  });

  it('persists registry, locks, claims and contracts across server restart', async () => {
    // Seed state across all four stores
    await call(client, 'manta.register', {
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: '/w',
      metadata: {},
    });
    await call(client, 'manta.lock', { clone_id: 'A', path: 'src/foo.ts' });
    await call(client, 'manta.claim_work', {
      clone_id: 'A',
      item: 'task-x',
      timeout_ms: 60_000,
    });
    await call(client, 'manta.task_contract.write', {
      contract: {
        clone_id: 'A',
        mode: 'recon-swarm',
        task: 'persist',
        scope: { allowed_paths: ['src/'], forbidden_paths: [], max_files_changed: 0 },
        sibling_clones: [],
        deadline_ms: 1_200_000,
      },
    });
    await close();

    // Restart with a fresh server pointed at the same repoRoot
    const { server: server2 } = await createBusServer({
      repoRoot: root,
      clock,
      staleLockMs: 15_000,
    });
    const [c2, s2] = InMemoryTransport.createLinkedPair();
    await server2.connect(s2);
    const client2 = new Client(
      { name: 'manta-bus-it2', version: '0.0.0' },
      { capabilities: {} },
    );
    await client2.connect(c2);
    close = async () => {
      await client2.close();
      await server2.close();
    };

    // registry — re-registering the same clone conflicts
    const regErr = await client2.callTool({
      name: 'manta.register',
      arguments: {
        clone_id: 'A',
        mode: 'recon-swarm',
        parent_pid: 1,
        worktree: '/w',
        metadata: {},
      },
    });
    expect(regErr.isError).toBe(true);
    const regParsed = JSON.parse(readText(regErr.content)) as { error: string };
    expect(regParsed.error).toBe('conflict');

    // locks — clone B cannot grab the lease A held before restart
    const lockErr = await client2.callTool({
      name: 'manta.lock',
      arguments: { clone_id: 'B', path: 'src/foo.ts' },
    });
    expect(lockErr.isError).toBe(true);
    const lockParsed = JSON.parse(readText(lockErr.content)) as { error: string };
    expect(lockParsed.error).toBe('locked');

    // claims — clone B cannot grab the claim A held before restart
    // Phase 2b: claim_work now verifies the caller is registered.
    await call(client2, 'manta.register', {
      clone_id: 'B',
      mode: 'recon-swarm',
      parent_pid: 2,
      worktree: '/w',
      metadata: {},
    });
    const claimErr = await client2.callTool({
      name: 'manta.claim_work',
      arguments: { clone_id: 'B', item: 'task-x', timeout_ms: 60_000 },
    });
    expect(claimErr.isError).toBe(true);
    const claimParsed = JSON.parse(readText(claimErr.content)) as { error: string };
    expect(claimParsed.error).toBe('conflict');

    // contracts — read returns the prior write verbatim
    const readResp = (await call(client2, 'manta.task_contract.read', {
      clone_id: 'A',
    })) as { stored: { contract: { task: string } } };
    expect(readResp.stored.contract.task).toBe('persist');
  });
});
