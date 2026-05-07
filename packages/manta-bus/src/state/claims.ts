import { atomicMutateJson, atomicReadJson } from '../atomic-fs';
import type { Clock } from '../clock';
import { BusConflictError } from '../errors';
import type { ClaimWorkInput, ReleaseWorkInput } from '../schema';
import type { BusPaths } from './paths';

export interface WorkClaim {
  item: string;
  owner_clone_id: string;
  claimed_at: number;
  expires_at: number;
}

interface ClaimsFile {
  version: 1;
  claims: Record<string, WorkClaim>;
}

const empty = (): ClaimsFile => ({ version: 1, claims: {} });

export class ClaimsStore {
  constructor(private readonly paths: BusPaths, private readonly clock: Clock) {}

  async claim(
    input: ClaimWorkInput,
    auditAppend?: () => Promise<void>,
  ): Promise<WorkClaim> {
    const now = this.clock.now();
    return atomicMutateJson<ClaimsFile>(
      this.paths.claims,
      empty,
      (current) => {
        const existing = current.claims[input.item];
        const expired = existing !== undefined && now >= existing.expires_at;
        if (existing && !expired && existing.owner_clone_id !== input.clone_id) {
          throw new BusConflictError(
            `item ${input.item} is already claimed by ${existing.owner_clone_id}`,
          );
        }
        current.claims[input.item] = {
          item: input.item,
          owner_clone_id: input.clone_id,
          claimed_at: now,
          expires_at: now + input.timeout_ms,
        };
        return current;
      },
      auditAppend,
    ).then((next) => next.claims[input.item]!);
  }

  async release(
    input: ReleaseWorkInput,
    auditAppend?: () => Promise<void>,
  ): Promise<void> {
    await atomicMutateJson<ClaimsFile>(
      this.paths.claims,
      empty,
      (current) => {
        const existing = current.claims[input.item];
        if (!existing) return current;
        if (existing.owner_clone_id !== input.clone_id) {
          throw new BusConflictError(
            `item ${input.item} is owned by ${existing.owner_clone_id}, not ${input.clone_id}`,
          );
        }
        delete current.claims[input.item];
        return current;
      },
      auditAppend,
    );
  }

  async list(): Promise<WorkClaim[]> {
    const file = await atomicReadJson<ClaimsFile>(this.paths.claims, empty);
    return Object.values(file.claims);
  }
}
