import { atomicMutateJson, atomicReadJson } from '../atomic-fs';
import type { Clock } from '../clock';
import { BusLockedError, BusNotFoundError } from '../errors';
import type { LockInput } from '../schema';
import type { BusPaths } from './paths';

export interface LockLease {
  path: string;
  owner_clone_id: string;
  acquired_at: number;
  last_heartbeat_at: number;
}

interface LocksFile {
  version: 1;
  leases: Record<string, LockLease>;
}

export interface LocksStoreOptions {
  staleAfterMs: number;
}

const empty = (): LocksFile => ({ version: 1, leases: {} });

export class LocksStore {
  constructor(
    private readonly paths: BusPaths,
    private readonly clock: Clock,
    private readonly options: LocksStoreOptions,
  ) {}

  async acquire(input: LockInput): Promise<LockLease> {
    const now = this.clock.now();
    return atomicMutateJson<LocksFile>(this.paths.locks, empty, (current) => {
      const existing = current.leases[input.path];
      const stale = existing !== undefined && now - existing.last_heartbeat_at > this.options.staleAfterMs;
      if (existing && !stale && existing.owner_clone_id !== input.clone_id) {
        throw new BusLockedError(input.path, existing.owner_clone_id);
      }
      if (existing && existing.owner_clone_id === input.clone_id && !stale) {
        existing.last_heartbeat_at = now;
        return current;
      }
      // either no lease, or lease is stale: take it
      current.leases[input.path] = {
        path: input.path,
        owner_clone_id: input.clone_id,
        acquired_at: now,
        last_heartbeat_at: now,
      };
      return current;
    }).then((next) => next.leases[input.path]!);
  }

  async renew(input: LockInput): Promise<LockLease> {
    return atomicMutateJson<LocksFile>(this.paths.locks, empty, (current) => {
      const existing = current.leases[input.path];
      if (!existing) throw new BusNotFoundError('lock', input.path);
      if (existing.owner_clone_id !== input.clone_id) {
        throw new BusLockedError(input.path, existing.owner_clone_id);
      }
      existing.last_heartbeat_at = this.clock.now();
      return current;
    }).then((next) => next.leases[input.path]!);
  }

  async release(input: LockInput): Promise<void> {
    await atomicMutateJson<LocksFile>(this.paths.locks, empty, (current) => {
      const existing = current.leases[input.path];
      if (!existing) return current;
      if (existing.owner_clone_id !== input.clone_id) {
        throw new BusLockedError(input.path, existing.owner_clone_id);
      }
      delete current.leases[input.path];
      return current;
    });
  }

  async listOwned(cloneId: string): Promise<LockLease[]> {
    const file = await atomicReadJson<LocksFile>(this.paths.locks, empty);
    return Object.values(file.leases).filter((l) => l.owner_clone_id === cloneId);
  }

  async reapStale(): Promise<LockLease[]> {
    const now = this.clock.now();
    const reaped: LockLease[] = [];
    await atomicMutateJson<LocksFile>(this.paths.locks, empty, (current) => {
      for (const [path, lease] of Object.entries(current.leases)) {
        if (now - lease.last_heartbeat_at > this.options.staleAfterMs) {
          reaped.push(lease);
          delete current.leases[path];
        }
      }
      return current;
    });
    return reaped;
  }
}
