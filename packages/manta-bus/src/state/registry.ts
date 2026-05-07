import { atomicMutateJson, atomicReadJson } from '../atomic-fs';
import type { Clock } from '../clock';
import { BusConflictError, BusNotFoundError } from '../errors';
import type { CloneState, HeartbeatInput, Mode, RegisterInput } from '../schema';
import type { BusPaths } from './paths';

export interface CloneRecord {
  clone_id: string;
  mode: Mode;
  parent_pid: number;
  worktree: string;
  metadata: Record<string, string>;
  registered_at: number;
  last_heartbeat_at: number;
  state: CloneState;
  progress?: string;
  death_reason?: string;
  died_at?: number;
}

interface RegistryFile {
  version: 1;
  clones: Record<string, CloneRecord>;
}

const empty = (): RegistryFile => ({ version: 1, clones: {} });

export class Registry {
  constructor(private readonly paths: BusPaths, private readonly clock: Clock) {}

  async register(input: RegisterInput): Promise<CloneRecord> {
    return atomicMutateJson<RegistryFile>(this.paths.registry, empty, (current) => {
      if (current.clones[input.clone_id]) {
        throw new BusConflictError(`clone ${input.clone_id} already registered`);
      }
      const now = this.clock.now();
      const record: CloneRecord = {
        clone_id: input.clone_id,
        mode: input.mode,
        parent_pid: input.parent_pid,
        worktree: input.worktree,
        metadata: input.metadata,
        registered_at: now,
        last_heartbeat_at: now,
        state: 'STARTING',
      };
      current.clones[input.clone_id] = record;
      return current;
    }).then((next) => next.clones[input.clone_id]!);
  }

  async heartbeat(input: HeartbeatInput): Promise<CloneRecord> {
    return atomicMutateJson<RegistryFile>(this.paths.registry, empty, (current) => {
      const r = current.clones[input.clone_id];
      if (!r) throw new BusNotFoundError('clone', input.clone_id);
      // Reject DEAD via heartbeat — markDead (called by manta.report_death) is
      // the only legitimate path to DEAD. Otherwise a heartbeat could leave
      // died_at / death_reason unset and confuse post-mortem.
      if (input.state === 'DEAD') {
        throw new BusConflictError(
          'heartbeat cannot transition to DEAD; use manta.report_death instead',
        );
      }
      // Reject heartbeat from a DEAD clone — death is terminal. Allowing a
      // post-death heartbeat to flip the state back to WORKING/etc. would
      // resurrect a clone the orchestrator has already given up on, leaving
      // sibling_clones references and contract acks pointing into the void.
      if (r.state === 'DEAD') {
        throw new BusConflictError(
          `cannot heartbeat a DEAD clone ${input.clone_id}; death is terminal`,
        );
      }
      r.last_heartbeat_at = this.clock.now();
      r.state = input.state;
      if (input.progress !== undefined) r.progress = input.progress;
      return current;
    }).then((next) => next.clones[input.clone_id]!);
  }

  async markDead(cloneId: string, reason: string): Promise<CloneRecord> {
    return atomicMutateJson<RegistryFile>(this.paths.registry, empty, (current) => {
      const r = current.clones[cloneId];
      if (!r) throw new BusNotFoundError('clone', cloneId);
      r.state = 'DEAD';
      r.death_reason = reason;
      r.died_at = this.clock.now();
      return current;
    }).then((next) => next.clones[cloneId]!);
  }

  async get(cloneId: string): Promise<CloneRecord> {
    const file = await atomicReadJson<RegistryFile>(this.paths.registry, empty);
    const r = file.clones[cloneId];
    if (!r) throw new BusNotFoundError('clone', cloneId);
    return r;
  }

  async list(): Promise<CloneRecord[]> {
    const file = await atomicReadJson<RegistryFile>(this.paths.registry, empty);
    return Object.values(file.clones);
  }

  async staleSince(thresholdMs: number): Promise<CloneRecord[]> {
    const now = this.clock.now();
    const file = await atomicReadJson<RegistryFile>(this.paths.registry, empty);
    return Object.values(file.clones).filter(
      (r) => r.state !== 'DEAD' && now - r.last_heartbeat_at > thresholdMs,
    );
  }
}
