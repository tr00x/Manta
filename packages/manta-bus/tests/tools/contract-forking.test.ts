import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FakeClock } from '../../src/clock';
import { busPaths } from '../../src/state/paths';
import { EventsLog } from '../../src/state/events';
import { Registry } from '../../src/state/registry';
import { ContractsStore } from '../../src/state/contracts';
import { makeTmpRoot } from '../helpers/tmpRoot';
import { createContractHandlers } from '../../src/tools/contract';

describe('manta.task_contract.read under forking-realities', () => {
  let root: string;
  let cleanup: () => Promise<void>;
  let clock: FakeClock;
  let registry: Registry;
  let contracts: ContractsStore;
  let handlers: ReturnType<typeof createContractHandlers>;

  beforeEach(async () => {
    ({ root, cleanup } = await makeTmpRoot());
    clock = new FakeClock(1_000_000);
    const paths = busPaths(root);
    registry = new Registry(paths, clock);
    contracts = new ContractsStore(paths, clock);
    handlers = createContractHandlers({
      events: new EventsLog(paths, clock),
      registry,
      contracts,
    });
  });
  afterEach(async () => {
    await cleanup();
  });

  it("rejects FR clone reading another clone's contract", async () => {
    await registry.register({
      clone_id: 'A',
      mode: 'forking-realities',
      parent_pid: 1,
      worktree: '/tmp/A',
      metadata: { cast_id: 'cast-1', cast_mode: 'forking-realities' },
    });
    await contracts.write({
      clone_id: 'B',
      mode: 'forking-realities',
      task: 'B-secret',
      scope: { allowed_paths: ['.'], forbidden_paths: [], max_files_changed: 1 },
      sibling_clones: ['A'],
      deadline_ms: 1_200_000,
    });
    await expect(
      handlers.read({ clone_id: 'B', requesting_clone_id: 'A' }),
    ).rejects.toMatchObject({
      name: 'BusForkingIsolationError',
      tool: 'manta.task_contract.read',
    });
  });

  it('allows FR clone reading own contract', async () => {
    await registry.register({
      clone_id: 'A',
      mode: 'forking-realities',
      parent_pid: 1,
      worktree: '/tmp/A',
      metadata: { cast_id: 'cast-1', cast_mode: 'forking-realities' },
    });
    await contracts.write({
      clone_id: 'A',
      mode: 'forking-realities',
      task: 'A-task',
      scope: { allowed_paths: ['.'], forbidden_paths: [], max_files_changed: 1 },
      sibling_clones: ['B'],
      deadline_ms: 1_200_000,
    });
    const r = await handlers.read({ clone_id: 'A', requesting_clone_id: 'A' });
    expect(r.stored.contract.task).toBe('A-task');
  });

  it('allows recon-swarm cross-clone reads (regression guard)', async () => {
    await registry.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: '/tmp/A',
      metadata: { cast_id: 'cast-1', cast_mode: 'recon-swarm' },
    });
    await contracts.write({
      clone_id: 'B',
      mode: 'recon-swarm',
      task: 'B-task',
      scope: { allowed_paths: ['.'], forbidden_paths: [], max_files_changed: 1 },
      sibling_clones: ['A'],
      deadline_ms: 1_200_000,
    });
    const r = await handlers.read({ clone_id: 'B', requesting_clone_id: 'A' });
    expect(r.stored.contract.task).toBe('B-task');
  });

  it('handler accepts requesting_clone_id omission for backward-compat', async () => {
    await contracts.write({
      clone_id: 'A',
      mode: 'recon-swarm',
      task: 'A-task',
      scope: { allowed_paths: ['.'], forbidden_paths: [], max_files_changed: 1 },
      sibling_clones: [],
      deadline_ms: 1_200_000,
    });
    const r = await handlers.read({ clone_id: 'A' });
    expect(r.stored.contract.task).toBe('A-task');
  });
});
