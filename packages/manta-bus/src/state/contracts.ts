// Format split (per spec Sec 5.1):
//   - Wire format for contracts is YAML (parsed by tools/contract.ts in
//     Chunk 2). The `yaml` dep stays in package.json for that.
//   - At-rest storage in this module is JSON. JSON gives us proper-lockfile +
//     atomic mutate semantics for free; the YAML↔JSON conversion happens at
//     the tool boundary, not here.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicMutateJson, atomicReadJson } from '../atomic-fs';
import type { Clock } from '../clock';
import { BusNotFoundError } from '../errors';
import type { TaskContract } from '../schema';
import type { BusPaths } from './paths';

/**
 * Recursively canonicalize a value for stable equality comparison:
 *   - Object keys are sorted alphabetically (insertion-order-independent).
 *   - Arrays are left in their original order — array order may carry
 *     meaning in our schema (e.g. `sibling_clones` priority,
 *     `allowed_paths` precedence). Sorting them would silently equate
 *     contracts with semantically different scopes.
 *   - Primitives are returned as-is.
 */
function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v !== null && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj)
        .sort()
        .map((k) => [k, canonicalize(obj[k])]),
    );
  }
  return v;
}

export interface ContractAck {
  interpretation: string;
  acked_at: number;
}

export interface StoredContract {
  contract: TaskContract;
  written_at: number;
  ack?: ContractAck;
}

const empty = (): StoredContract => ({
  contract: {} as TaskContract,
  written_at: 0,
});

export class ContractsStore {
  constructor(private readonly paths: BusPaths, private readonly clock: Clock) {}

  async write(
    contract: TaskContract,
    auditAppend?: () => Promise<void>,
  ): Promise<StoredContract> {
    const file = this.paths.contractFile(contract.clone_id);
    await fs.mkdir(path.dirname(file), { recursive: true });
    return atomicMutateJson<StoredContract>(
      file,
      empty,
      (current) => {
        // If the contract body is byte-equal to the prior one, preserve the ack
        // (idempotent rewrite). Otherwise clear it: per spec Sec 5.1 the ack is
        // the clone's interpretation of its CURRENT scope; a new contract body
        // requires a fresh ack so scope conflicts are caught against the new
        // contract, not the old one.
        const sameBody =
          current.written_at !== 0 &&
          JSON.stringify(canonicalize(current.contract)) ===
            JSON.stringify(canonicalize(contract));
        const next: StoredContract = {
          contract,
          written_at: this.clock.now(),
        };
        if (sameBody && current.ack) {
          next.ack = current.ack;
        }
        return next;
      },
      auditAppend,
    );
  }

  async read(cloneId: string): Promise<StoredContract> {
    const file = this.paths.contractFile(cloneId);
    const stored = await atomicReadJson<StoredContract | null>(file, () => null);
    if (!stored || stored.written_at === 0) {
      throw new BusNotFoundError('contract', cloneId);
    }
    return stored;
  }

  async ack(
    cloneId: string,
    interpretation: string,
    auditAppend?: () => Promise<void>,
  ): Promise<ContractAck> {
    const file = this.paths.contractFile(cloneId);
    const next = await atomicMutateJson<StoredContract | null>(
      file,
      () => null,
      (current) => {
        if (!current || current.written_at === 0) {
          throw new BusNotFoundError('contract', cloneId);
        }
        current.ack = { interpretation, acked_at: this.clock.now() };
        return current;
      },
      auditAppend,
    );
    return next!.ack!;
  }

  async list(): Promise<StoredContract[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.paths.contractsDir);
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'ENOENT') {
        return [];
      }
      throw err;
    }
    const out: StoredContract[] = [];
    for (const e of entries) {
      if (!e.endsWith('.json')) continue;
      const file = path.join(this.paths.contractsDir, e);
      const stored = await atomicReadJson<StoredContract | null>(file, () => null);
      if (stored && stored.written_at !== 0) out.push(stored);
    }
    return out;
  }
}
