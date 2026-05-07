import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FakeClock } from '../../src/clock';
import { busPaths } from '../../src/state/paths';
import { ContractsStore } from '../../src/state/contracts';
import { EventsLog } from '../../src/state/events';
import { makeTmpRoot } from '../helpers/tmpRoot';
import { createContractHandlers } from '../../src/tools/contract';
import { BusNotFoundError, BusValidationError } from '../../src/errors';

describe('contract handlers', () => {
  let root: string;
  let cleanup: () => Promise<void>;
  let clock: FakeClock;
  let handlers: ReturnType<typeof createContractHandlers>;

  beforeEach(async () => {
    ({ root, cleanup } = await makeTmpRoot());
    clock = new FakeClock(1_000_000);
    const paths = busPaths(root);
    handlers = createContractHandlers({
      contracts: new ContractsStore(paths, clock),
      events: new EventsLog(paths, clock),
    });
  });
  afterEach(async () => {
    await cleanup();
  });

  const valid = {
    clone_id: 'A',
    mode: 'recon-swarm' as const,
    task: 'map repo',
    scope: { allowed_paths: ['src/'], forbidden_paths: [], max_files_changed: 0 },
    sibling_clones: [],
    deadline_ms: 1_200_000,
  };

  it('write stores the contract and emits event', async () => {
    const r = await handlers.write({ contract: valid });
    expect(r.stored.contract).toEqual(valid);
    expect(r.event.type).toBe('contract_write');
  });

  it('write rejects invalid contract', async () => {
    await expect(
      handlers.write({ contract: { clone_id: 'A' } }),
    ).rejects.toBeInstanceOf(BusValidationError);
  });

  it('read returns prior write', async () => {
    await handlers.write({ contract: valid });
    const r = await handlers.read({ clone_id: 'A' });
    expect(r.stored.contract).toEqual(valid);
  });

  it('read of unknown clone raises BusNotFoundError', async () => {
    await expect(handlers.read({ clone_id: 'GHOST' })).rejects.toBeInstanceOf(BusNotFoundError);
  });

  it('ack records interpretation', async () => {
    await handlers.write({ contract: valid });
    const r = await handlers.ack({ clone_id: 'A', interpretation: 'will only touch src/' });
    expect(r.ack.interpretation).toBe('will only touch src/');
    expect(r.event.type).toBe('contract_ack');
  });

  it('ack rejects empty interpretation', async () => {
    await handlers.write({ contract: valid });
    await expect(
      handlers.ack({ clone_id: 'A', interpretation: '' }),
    ).rejects.toBeInstanceOf(BusValidationError);
  });

  it('refresh emits a broadcast-style refresh event', async () => {
    const r = await handlers.refresh({ payload: { phase: 0 } });
    expect(r.event.type).toBe('contract_refresh');
    expect(r.event.payload).toEqual({ phase: 0 });
  });

  it('refresh accepts an empty default payload', async () => {
    const r = await handlers.refresh({});
    expect(r.event.type).toBe('contract_refresh');
    expect(r.event.payload).toEqual({});
  });
});
