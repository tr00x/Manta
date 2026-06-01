import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCastCommand } from '../../src/commands/cast.js';
import { runFakeCloneScript } from '../../src/spawner/clone-spawner.js';
import { createRuntime } from '../../src/runtime.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';
import {
  createCommunicationHandlers,
  createContractHandlers,
  createWorkHandlers,
} from '@manta/bus';

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'fake-clone.mjs',
);

describe('forking-realities end-to-end isolation', () => {
  let fx: RepoFixture | undefined;
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  it('every Strategy 1 boundary holds across a 2-clone FR cast', async () => {
    fx = await makeRepoFixture('manta-fr-iso-');
    const rt = await createRuntime({
      repoRoot: fx.root,
      thresholdOverrides: {
        heartbeatTimeoutMs: 100,
        startupGraceMs: 100,
        parentPidCheckEnabled: false,
      },
    });
    const result = await runCastCommand(rt, {
      mode: 'forking-realities',
      task: 'irrelevant — overridden per-clone',
      cloneCount: 2,
      cycleIntervalMs: 50,
      tickBudgetMs: 30_000,
      castId: 'cast-iso-1',
      cloneAssignments: {
        A: { task: 'algorithm-only' },
        B: { task: 'index-based' },
      },
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      reporter: { info: () => {}, warn: () => {}, error: () => {} },
      verifyMcp: false,
    });
    expect(result.exitCode).toBe(0);

    const comm = createCommunicationHandlers(rt.ctx);
    const contractH = createContractHandlers(rt.ctx);
    const workH = createWorkHandlers(rt.ctx);

    // 1. Sibling-to-sibling message rejected.
    await expect(
      comm.message({
        from_clone_id: 'A',
        to_clone_id: 'B',
        payload: { exfil: 'draft' },
      }),
    ).rejects.toMatchObject({
      name: 'BusForkingIsolationError',
      tool: 'manta.message',
    });

    // 2. Cross-clone task_contract.read rejected.
    await expect(
      contractH.read({ clone_id: 'B', requesting_clone_id: 'A' }),
    ).rejects.toMatchObject({
      name: 'BusForkingIsolationError',
      tool: 'manta.task_contract.read',
    });

    // 3. Self-read still works.
    const selfA = await contractH.read({
      clone_id: 'A',
      requesting_clone_id: 'A',
    });
    expect(selfA.stored.contract.task).toBe('algorithm-only');

    // 4. claim_work rejected for both clones.
    for (const id of ['A', 'B'] as const) {
      await expect(
        workH.claim({ clone_id: id, item: 'task-x', timeout_ms: 60_000 }),
      ).rejects.toMatchObject({
        name: 'BusForkingIsolationError',
        tool: 'manta.claim_work',
      });
    }

    // 5. Broadcast event payload has cast_id + cast_mode stamped.
    const evt = await comm.broadcast({
      clone_id: 'A',
      event_type: 'breakthrough',
      payload: { what: 'something' },
    });
    expect(evt.event.payload).toMatchObject({
      cast_id: 'cast-iso-1',
      cast_mode: 'forking-realities',
    });
  });
});
