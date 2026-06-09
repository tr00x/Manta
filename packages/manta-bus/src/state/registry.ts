import { atomicMutateJson, atomicReadJson } from '../atomic-fs';
import type { Clock } from '../clock';
import { BusConflictError, BusNotFoundError } from '../errors';
import type { CloneState, HeartbeatInput, Mode, RegisterInput } from '../schema';
import type { BusPaths } from './paths';

export interface CloneRecord {
  clone_id: string;
  mode: Mode;
  parent_pid: number;
  /**
   * The clone's OWN OS process id (the `claude --print` child). Unset until the
   * spawner launches the process (register pre-registers BEFORE the process
   * exists, so it starts undefined and `recordClonePid` fills it in). Used by
   * `manta abort`/`kill`/`recover` to SIGTERM/SIGKILL the actual process — not
   * just mark the row DEAD — even after the parent cast process has exited (#65).
   */
  clone_pid?: number;
  worktree: string;
  metadata: Record<string, string>;
  registered_at: number;
  last_heartbeat_at: number;
  state: CloneState;
  progress?: string;
  death_reason?: string;
  died_at?: number;
  idle_since?: number;
  tasks_completed?: number;
  last_task_completed_at?: number;
  session_mode?: 'batch' | 'daemon';
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
        if (input.state === 'IDLE') {
          if (r.state === 'BLOCKED') {
            throw new BusConflictError(
              `cannot transition from BLOCKED to IDLE; unblock to WORKING first`,
            );
          }
          r.idle_since = this.clock.now();
          r.tasks_completed = (r.tasks_completed ?? 0) + 1;
          r.last_task_completed_at = this.clock.now();
        }
        if (r.state === 'IDLE' && input.state === 'WORKING') {
          delete r.idle_since;
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

  /**
   * Persist a clone's OWN OS process id once the spawner has launched it.
   * Pre-registration (`register`) runs BEFORE the `claude --print` child exists,
   * so `clone_pid` starts undefined and is filled in here right after launch.
   *
   * Why it matters (#65): the registry only stored `parent_pid` (the `manta
   * cast` spawner's pid). A clone whose parent cast process has exited is
   * reparented to init — a SEPARATE `manta abort`/`kill`/`recover` process can
   * no longer reach it through the parent's process group, so the orphan keeps
   * burning subscription rate while merely marked DEAD. Persisting the clone's
   * own pid lets any later operator command signal the actual process.
   *
   * Records even on a DEAD record (skeptic-review #65-2): the pid is known-
   * correct at spawn time regardless of registry state, and if the reaper marked
   * the clone DEAD in the tiny window between `register` and this call, dropping
   * the pid would manufacture an orphan that `kill`/`recover` can never reach
   * (they signal `clone_pid`, and a reparented orphan's parent group is gone) —
   * the exact failure #65 fixes. Storing the pid does NOT revive the clone (state
   * is untouched); the kill paths gate the SIGNAL on liveness + DEAD-state, never
   * the storage on state. Only silent no-op is an ABSENT record (no row to set).
   */
  async recordClonePid(
    cloneId: string,
    pid: number,
    auditAppend?: () => Promise<void>,
  ): Promise<void> {
    await atomicMutateJson<RegistryFile>(
      this.paths.registry,
      empty,
      (current) => {
        const r = current.clones[cloneId];
        if (!r) return current;
        r.clone_pid = pid;
        return current;
      },
      auditAppend,
    );
  }

  async markDead(
    cloneId: string,
    reason: string,
    auditAppend?: () => Promise<void>,
    observedLastHeartbeatAt?: number,
  ): Promise<CloneRecord> {
    return atomicMutateJson<RegistryFile>(
      this.paths.registry,
      empty,
      (current) => {
        const r = current.clones[cloneId];
        if (!r) throw new BusNotFoundError('clone', cloneId);
        // Bug #38 fix: liveness recheck INSIDE the file mutex. The detector
        // read `observedLastHeartbeatAt` outside the lock; if a heartbeat
        // landed between detection and this mutator, the clone is alive and
        // we must abort — marking it DEAD now would permanently lock it off
        // the bus (heartbeat rejects DEAD at registry.ts:75-90). The recheck
        // runs under the same lock as heartbeat, closing the window.
        if (observedLastHeartbeatAt !== undefined && r.last_heartbeat_at !== observedLastHeartbeatAt) {
          throw new BusConflictError(
            `clone ${cloneId} revived: last_heartbeat_at advanced from ${observedLastHeartbeatAt} to ${r.last_heartbeat_at} since detection — aborting markDead`,
          );
        }
        r.state = 'DEAD';
        r.death_reason = reason;
        r.died_at = this.clock.now();
        return current;
      },
      auditAppend,
    ).then((next) => next.clones[cloneId]!);
  }

  /**
   * Remove clone records matching `shouldPurge`. Only EVER deletes records that
   * are already terminal (`state === 'DEAD'`) AND satisfy the predicate, re-
   * checked under the file mutex — so a record re-registered (DEAD → STARTING)
   * between the caller's snapshot and this mutation is left untouched. Returns
   * the ids actually removed.
   *
   * GC for settled DEAD records (`manta recover --purge-dead`, bug #68). This is
   * the one mutation that does NOT need a paired-inside-the-mutex audit append
   * (#24/#54): the clone's `death` event already lives in `events.jsonl` as the
   * permanent historical record, so dropping the (terminal) registry row loses
   * no reconstruction information — it's pure GC, not a state transition. The
   * caller logs a single `recover_purged_dead` event with the returned ids.
   */
  async purgeDead(shouldPurge: (record: CloneRecord) => boolean): Promise<string[]> {
    const removed: string[] = [];
    await atomicMutateJson<RegistryFile>(this.paths.registry, empty, (current) => {
      // Reset on every invocation: atomicMutateJson may re-run the mutator on
      // lock contention, and we must not double-count a retried purge.
      removed.length = 0;
      for (const [id, r] of Object.entries(current.clones)) {
        if (r.state === 'DEAD' && shouldPurge(r)) {
          delete current.clones[id];
          removed.push(id);
        }
      }
      return current;
    });
    return removed;
  }

  async get(cloneId: string): Promise<CloneRecord> {
    const file = await atomicReadJson<RegistryFile>(this.paths.registry, empty);
    const r = file.clones[cloneId];
    if (!r) throw new BusNotFoundError('clone', cloneId);
    return r;
  }

  /**
   * bug #70: read a clone's current state, or null if the record is gone.
   * Non-throwing variant of `get`, used by the spawner's booting-ticker to
   * decide whether to keep emitting cold-boot heartbeats (STARTING) or stop
   * (any settled/absent state). Avoids the caller having to try/catch
   * BusNotFoundError on every tick.
   */
  async getState(cloneId: string): Promise<string | null> {
    const file = await atomicReadJson<RegistryFile>(this.paths.registry, empty);
    return file.clones[cloneId]?.state ?? null;
  }

  async list(): Promise<CloneRecord[]> {
    const file = await atomicReadJson<RegistryFile>(this.paths.registry, empty);
    return Object.values(file.clones);
  }

  async retask(
    cloneId: string,
    taskSummary: string,
    auditAppend?: () => Promise<void>,
  ): Promise<CloneRecord> {
    return atomicMutateJson<RegistryFile>(
      this.paths.registry,
      empty,
      (current) => {
        const r = current.clones[cloneId];
        if (!r) throw new BusNotFoundError('clone', cloneId);
        if (r.state !== 'IDLE' && r.state !== 'WAITING_FOR_TASK') {
          throw new BusConflictError(
            `cannot retask clone ${cloneId} in state ${r.state}; must be IDLE or WAITING_FOR_TASK`,
          );
        }
        r.state = 'WORKING';
        delete r.idle_since;
        r.last_heartbeat_at = this.clock.now();
        r.progress = `retasked: ${taskSummary.slice(0, 200)}`;
        return current;
      },
      auditAppend,
    ).then((next) => next.clones[cloneId]!);
  }

  async staleSince(thresholdMs: number, idleThresholdMs?: number): Promise<CloneRecord[]> {
    const now = this.clock.now();
    const file = await atomicReadJson<RegistryFile>(this.paths.registry, empty);
    return Object.values(file.clones).filter((r) => {
      if (r.state === 'DEAD') return false;
      if (r.state === 'IDLE' || r.state === 'WAITING_FOR_TASK') {
        const effectiveThreshold = idleThresholdMs ?? thresholdMs;
        return now - r.last_heartbeat_at > effectiveThreshold;
      }
      return now - r.last_heartbeat_at > thresholdMs;
    });
  }
}
