import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { FakeClock } from '../../src/clock';
import { createBusServer } from '../../src/server';
import { makeTmpRoot } from '../helpers/tmpRoot';
import type { BusContext } from '../../src/tools/index';

/**
 * Bug #23 regression — the dispatcher's auto-touch must advance the *caller*'s
 * heartbeat, never the *subject*'s, for tools where caller ≠ subject:
 *   - manta.message — caller is `from_clone_id` (subject is `to_clone_id`)
 *   - manta.task_contract.read — caller is `requesting_clone_id` when present
 *     (subject is `clone_id`)
 *   - manta.feedback / retask / pause / resume / enqueue_work — caller is the
 *     main agent; no clone is on the calling end of the wire so auto-touch
 *     must be a no-op (the target's heartbeat is owned by the target itself
 *     or by the handler's own state-transition logic).
 */
describe('createBusServer — auto-touch is caller-keyed, not subject-keyed (bug #23)', () => {
  let root: string;
  let cleanup: () => Promise<void>;
  let clock: FakeClock;
  let client: Client;
  let context: BusContext;
  let serverClose: () => Promise<void>;

  beforeEach(async () => {
    ({ root, cleanup } = await makeTmpRoot());
    clock = new FakeClock(1_000_000);
    const handle = await createBusServer({ repoRoot: root, clock });
    context = handle.context;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await handle.server.connect(serverTransport);
    client = new Client(
      { name: 'manta-bus-bug-23', version: '0.0.0' },
      { capabilities: {} },
    );
    await client.connect(clientTransport);
    serverClose = async () => {
      await client.close();
      await handle.server.close();
    };
  });

  afterEach(async () => {
    await serverClose();
    await cleanup();
  });

  async function registerAndWork(cloneId: string): Promise<void> {
    await client.callTool({
      name: 'manta.register',
      arguments: {
        clone_id: cloneId,
        mode: 'recon-swarm',
        parent_pid: 1,
        worktree: `/w/${cloneId}`,
        metadata: {},
      },
    });
    await client.callTool({
      name: 'manta.heartbeat',
      arguments: { clone_id: cloneId, state: 'WORKING' },
    });
  }

  it('manta.message: from_clone_id is the caller; to_clone_id heartbeat unchanged', async () => {
    await registerAndWork('A');
    await registerAndWork('B');
    const aBefore = await context.registry.get('A');
    const bBefore = await context.registry.get('B');
    expect(aBefore.last_heartbeat_at).toBe(1_000_000);
    expect(bBefore.last_heartbeat_at).toBe(1_000_000);

    clock.advance(60_000);

    const r = await client.callTool({
      name: 'manta.message',
      arguments: { from_clone_id: 'A', to_clone_id: 'B', payload: { kind: 'hello' } },
    });
    expect(r.isError).toBeFalsy();

    const aAfter = await context.registry.get('A');
    const bAfter = await context.registry.get('B');
    expect(aAfter.last_heartbeat_at).toBe(1_060_000); // caller touched
    expect(bAfter.last_heartbeat_at).toBe(1_000_000); // recipient untouched
  });

  it('manta.task_contract.read: requesting_clone_id is the caller; clone_id (subject) heartbeat unchanged', async () => {
    await registerAndWork('A');
    await registerAndWork('B');
    // Write a contract for B so the read can succeed.
    await client.callTool({
      name: 'manta.task_contract.write',
      arguments: {
        contract: {
          clone_id: 'B',
          mode: 'recon-swarm',
          task: 'do the thing',
          scope: { allowed_paths: ['src/'], forbidden_paths: [], max_files_changed: 5 },
          sibling_clones: [],
          deadline_ms: 60_000,
        },
      },
    });

    const aBefore = await context.registry.get('A');
    const bBefore = await context.registry.get('B');
    expect(aBefore.last_heartbeat_at).toBe(1_000_000);
    expect(bBefore.last_heartbeat_at).toBe(1_000_000);

    clock.advance(45_000);

    // A reads B's contract on B's behalf — A is the caller.
    const r = await client.callTool({
      name: 'manta.task_contract.read',
      arguments: { clone_id: 'B', requesting_clone_id: 'A' },
    });
    expect(r.isError).toBeFalsy();

    const aAfter = await context.registry.get('A');
    const bAfter = await context.registry.get('B');
    expect(aAfter.last_heartbeat_at).toBe(1_045_000); // caller (requester) touched
    expect(bAfter.last_heartbeat_at).toBe(1_000_000); // subject untouched
  });

  it('manta.task_contract.read without requesting_clone_id: clone_id is the caller (self-read)', async () => {
    // Regression guard: a clone reading its own contract still counts as a
    // self-touch — the caller is the clone itself.
    await registerAndWork('A');
    await client.callTool({
      name: 'manta.task_contract.write',
      arguments: {
        contract: {
          clone_id: 'A',
          mode: 'recon-swarm',
          task: 'do the thing',
          scope: { allowed_paths: ['src/'], forbidden_paths: [], max_files_changed: 5 },
          sibling_clones: [],
          deadline_ms: 60_000,
        },
      },
    });
    const before = await context.registry.get('A');
    expect(before.last_heartbeat_at).toBe(1_000_000);

    clock.advance(30_000);
    const r = await client.callTool({
      name: 'manta.task_contract.read',
      arguments: { clone_id: 'A' },
    });
    expect(r.isError).toBeFalsy();

    const after = await context.registry.get('A');
    expect(after.last_heartbeat_at).toBe(1_030_000);
  });

  it('manta.feedback: main-driven, target heartbeat NOT advanced by auto-touch', async () => {
    await registerAndWork('A');
    const before = await context.registry.get('A');
    expect(before.last_heartbeat_at).toBe(1_000_000);

    clock.advance(60_000);
    const r = await client.callTool({
      name: 'manta.feedback',
      arguments: { clone_id: 'A', from: 'main', feedback: 'consider X', severity: 'info' },
    });
    expect(r.isError).toBeFalsy();

    const after = await context.registry.get('A');
    // Feedback handler does NOT itself touch the target's heartbeat; auto-
    // touch must not either — main's call is not a liveness signal for A.
    expect(after.last_heartbeat_at).toBe(1_000_000);
  });

  it('manta.enqueue_work: main-driven, target heartbeat NOT advanced by auto-touch', async () => {
    await registerAndWork('A');
    const before = await context.registry.get('A');
    expect(before.last_heartbeat_at).toBe(1_000_000);

    clock.advance(60_000);
    const r = await client.callTool({
      name: 'manta.enqueue_work',
      arguments: { cast_id: 'cast-123', target_clone_id: 'A', prompt: 'work on X' },
    });
    expect(r.isError).toBeFalsy();

    const after = await context.registry.get('A');
    expect(after.last_heartbeat_at).toBe(1_000_000);
  });

  it('manta.contract_refresh: main-driven, no clone touched by auto-touch', async () => {
    await registerAndWork('A');
    const before = await context.registry.get('A');
    expect(before.last_heartbeat_at).toBe(1_000_000);

    clock.advance(60_000);
    const r = await client.callTool({
      name: 'manta.contract_refresh',
      arguments: { payload: { reason: 'main edited scope' } },
    });
    expect(r.isError).toBeFalsy();

    const after = await context.registry.get('A');
    expect(after.last_heartbeat_at).toBe(1_000_000);
  });

  it('manta.task_contract.write: main-driven, target heartbeat NOT advanced by auto-touch', async () => {
    await registerAndWork('A');
    const before = await context.registry.get('A');
    expect(before.last_heartbeat_at).toBe(1_000_000);

    clock.advance(60_000);
    const r = await client.callTool({
      name: 'manta.task_contract.write',
      arguments: {
        contract: {
          clone_id: 'A',
          mode: 'recon-swarm',
          task: 'fresh task from main',
          scope: { allowed_paths: ['src/'], forbidden_paths: [], max_files_changed: 5 },
          sibling_clones: [],
          deadline_ms: 60_000,
        },
      },
    });
    expect(r.isError).toBeFalsy();

    const after = await context.registry.get('A');
    expect(after.last_heartbeat_at).toBe(1_000_000);
  });

  it('regression: clone-self lifecycle calls (heartbeat/zk_write/lock) still auto-touch', async () => {
    // Don't lose the bug #9 fix while plugging #23 — the common-case caller
    // is always the clone itself for these tools.
    await registerAndWork('A');
    clock.advance(50_000);
    await client.callTool({
      name: 'manta.lock',
      arguments: { clone_id: 'A', path: 'docs/example.md' },
    });
    const after = await context.registry.get('A');
    expect(after.last_heartbeat_at).toBe(1_050_000);
  });
});
