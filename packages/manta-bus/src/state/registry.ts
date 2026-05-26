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

  async register(
    input: RegisterInput,
    auditAppend?: () => Promise<void>,
  ): Promise<CloneRecord> {
    return atomicMutateJson<RegistryFile>(
      this.paths.registry,
      empty,
      (current) => {
        const existing = current.clones[input.clone_id];
        if (existing && existing.state !== 'DEAD') {
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
      },
      auditAppend,
    ).then((next) => next.clones[input.clone_id]!);
  }

  async heartbeat(
    input: HeartbeatInput,
    auditAppend?: () => Promise<void>,
  ): Promise<CloneRecord> {
    return atomicMutateJson<RegistryFile>(
      this.paths.registry,
      empty,
      (current) => {
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
      },
      auditAppend,
    ).then((next) => next.clones[input.clone_id]!);
  }

  /**
   * Touch a clone's `last_heartbeat_at` as a side-effect of any successful
   * MCP call from that clone. Any bus interaction IS a liveness signal — the
   * server.ts dispatcher invokes this after every successful handler whose
   * args include a `clone_id`, so the orchestrator's death-detector no longer
   * depends on the clone explicitly calling `manta.heartbeat`.
   *
   * Silent no-op contract:
   * - Clone not in registry → no-op (e.g. main-side calls with synthetic ids;
   *   we do not want a typo to throw mid-dispatch).
   * - Clone is DEAD → no-op (death is terminal; touching would resurrect a
   *   record the orchestrator has already given up on, leaving sibling
   *   references and post-mortems pointing into the void).
   * - Clone is WORKING/STARTING/WINDING_DOWN/BLOCKED → update only
   *   `last_heartbeat_at`; never change `state` (that's heartbeat's job, with
   *   its explicit `state` argument).
   *
   * Closes `docs/manta-bugs.md` #9 (heartbeat cadence as bus side-effect, not
   * skill discipline). See `docs/post-mortems/2026-05-07-cast-1778189501846-
   * validation.md` for why skill-level enforcement was insufficient.
   */
  async touch(cloneId: string, auditAppend?: () => Promise<void>): Promise<void> {
    await atomicMutateJson<RegistryFile>(
      this.paths.registry,
      empty,
      (current) => {
        const r = current.clones[cloneId];
        if (!r) return current;
        if (r.state === 'DEAD') return current;
        r.last_heartbeat_at = this.clock.now();
        return current;
      },
      auditAppend,
    );
  }

  async markDead(
    cloneId: string,
    reason: string,
    auditAppend?: () => Promise<void>,
  ): Promise<CloneRecord> {
    return atomicMutateJson<RegistryFile>(
      this.paths.registry,
      empty,
      (current) => {
        const r = current.clones[cloneId];
        if (!r) throw new BusNotFoundError('clone', cloneId);
        r.state = 'DEAD';
        r.death_reason = reason;
        r.died_at = this.clock.now();
        return current;
      },
      auditAppend,
    ).then((next) => next.clones[cloneId]!);
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
