import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FakeClock } from '../../src/clock';
import { busPaths } from '../../src/state/paths';
import { ContractsStore } from '../../src/state/contracts';
import { makeTmpRoot } from '../helpers/tmpRoot';
import { BusNotFoundError } from '../../src/errors';
import type { TaskContract } from '../../src/schema';

const sample = (overrides: Partial<TaskContract> = {}): TaskContract => ({
  clone_id: 'A',
  mode: 'recon-swarm',
  task: 'map the codebase',
  scope: { allowed_paths: ['src/'], forbidden_paths: ['secrets/'], max_files_changed: 0 },
  sibling_clones: [],
  deadline_ms: 1_200_000,
  ...overrides,
});

describe('ContractsStore', () => {
  let root: string;
  let cleanup: () => Promise<void>;
  let clock: FakeClock;
  let contracts: ContractsStore;

  beforeEach(async () => {
    ({ root, cleanup } = await makeTmpRoot());
    clock = new FakeClock(1_000_000);
    contracts = new ContractsStore(busPaths(root), clock);
  });
  afterEach(async () => {
    await cleanup();
  });

  it('write then read returns the same contract', async () => {
    const c = sample();
    await contracts.write(c);
    const got = await contracts.read('A');
    expect(got.contract).toEqual(c);
    expect(got.written_at).toBe(1_000_000);
  });

  it('write twice overwrites and updates written_at', async () => {
    await contracts.write(sample({ task: 'first' }));
    clock.advance(5_000);
    await contracts.write(sample({ task: 'second' }));
    const got = await contracts.read('A');
    expect(got.contract.task).toBe('second');
    expect(got.written_at).toBe(1_005_000);
  });

  it('read for unknown clone_id is not-found', async () => {
    await expect(contracts.read('GHOST')).rejects.toBeInstanceOf(BusNotFoundError);
  });

  it('ack records interpretation and acked_at', async () => {
    await contracts.write(sample());
    clock.advance(2_000);
    const acked = await contracts.ack('A', 'I will only touch src/');
    expect(acked.interpretation).toBe('I will only touch src/');
    expect(acked.acked_at).toBe(1_002_000);
    const got = await contracts.read('A');
    expect(got.ack?.interpretation).toBe('I will only touch src/');
  });

  it('rewriting the contract body clears the prior ack (new scope → new ack)', async () => {
    await contracts.write(sample({ task: 'first' }));
    await contracts.ack('A', 'plan one');
    await contracts.write(sample({ task: 'second' }));
    const got = await contracts.read('A');
    expect(got.ack).toBeUndefined();
  });

  it('rewriting the same contract body preserves the ack (idempotent)', async () => {
    await contracts.write(sample());
    await contracts.ack('A', 'plan one');
    await contracts.write(sample());
    const got = await contracts.read('A');
    expect(got.ack?.interpretation).toBe('plan one');
  });

  it('ack without prior write is not-found', async () => {
    await expect(contracts.ack('GHOST', 'x')).rejects.toBeInstanceOf(BusNotFoundError);
  });

  it('list returns all stored contracts', async () => {
    await contracts.write(sample({ clone_id: 'A' }));
    await contracts.write(sample({ clone_id: 'B' }));
    const all = await contracts.list();
    expect(all.map((c) => c.contract.clone_id).sort()).toEqual(['A', 'B']);
  });
});
