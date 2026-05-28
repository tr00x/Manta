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

  it('rewriting the same contract with reordered object keys preserves the ack (canonical compare)', async () => {
    // Regression test for Fix #5: pre-fix, JSON.stringify order-sensitivity
    // could falsely treat an object-key-reordered rewrite as a body change.
    const original = sample({ task: 'first' });
    await contracts.write(original);
    await contracts.ack('A', 'plan one');
    // Build a key-reordered copy without changing semantics. Using
    // Object.fromEntries on reversed keys to guarantee a different in-memory
    // key insertion order.
    const reordered = Object.fromEntries(
      Object.entries(original).reverse(),
    ) as unknown as TaskContract;
    await contracts.write(reordered);
    const got = await contracts.read('A');
    expect(got.ack?.interpretation).toBe('plan one');
  });

  it('rewriting the contract with a reordered sibling_clones array clears the ack (array order is significant)', async () => {
    // Regression test for Fix #5: arrays carry meaning (sibling_clones order
    // can encode priority, allowed_paths order can affect glob precedence).
    // The canonicalizer must NOT sort arrays.
    await contracts.write(sample({ sibling_clones: ['B', 'C'] }));
    await contracts.ack('A', 'plan one');
    await contracts.write(sample({ sibling_clones: ['C', 'B'] }));
    const got = await contracts.read('A');
    expect(got.ack).toBeUndefined();
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

  // Bug #30 regression: ContractsStore.write used to stamp a fresh
  // `written_at = clock.now()` even on byte-identical re-writes. That
  // changed the JSON snapshot every time, so atomicMutateJson's "changed"
  // check fired and the contract_write audit event was emitted on every
  // call — flooding events.jsonl with no-op rewrites. The fix is the
  // CastsStore.create pattern: detect sameBody and return `current`
  // unchanged so the snapshot is byte-equal and auditAppend is suppressed.
  it('byte-identical re-write does not emit a second contract_write audit event (bug #30)', async () => {
    let auditCalls = 0;
    const auditAppend = async () => {
      auditCalls++;
    };
    const c = sample();
    await contracts.write(c, auditAppend);
    expect(auditCalls).toBe(1);

    // Advance the clock so a fresh `written_at: this.clock.now()` would
    // still differ — proving the suppression doesn't depend on clock
    // staying static.
    clock.advance(5_000);
    await contracts.write(c, auditAppend);
    expect(auditCalls).toBe(1); // unchanged — no second audit event

    // A real body change still emits.
    await contracts.write(sample({ task: 'changed' }), auditAppend);
    expect(auditCalls).toBe(2);
  });

  it('byte-identical re-write preserves prior written_at (bug #30)', async () => {
    await contracts.write(sample());
    const first = await contracts.read('A');
    expect(first.written_at).toBe(1_000_000);

    clock.advance(7_777);
    await contracts.write(sample()); // identical body
    const second = await contracts.read('A');
    expect(second.written_at).toBe(1_000_000); // unchanged
  });
});
