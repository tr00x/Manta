import type { CloneRecord, RegisterInput } from '@manta/bus';

export interface RegistryFake {
  records: CloneRecord[];
  register(input: RegisterInput): Promise<CloneRecord>;
  touch(cloneId: string): Promise<void>;
  recordClonePid(cloneId: string, pid: number): Promise<void>;
  getState(cloneId: string): Promise<string | null>;
  markDead(cloneId: string, reason: string): Promise<CloneRecord>;
  get(cloneId: string): Promise<CloneRecord>;
}

export interface RegistryFakeOptions {
  onRegister?: (input: RegisterInput) => void | Promise<void>;
  onMarkDead?: (cloneId: string) => void | Promise<void>;
}

export function makeRegistryFake(opts: RegistryFakeOptions = {}): RegistryFake {
  const records: CloneRecord[] = [];
  let now = 1_700_000_000_000;
  return {
    records,
    async register(input) {
      if (opts.onRegister) await opts.onRegister(input);
      if (records.find((r) => r.clone_id === input.clone_id)) {
        throw new Error(`clone ${input.clone_id} already registered`);
      }
      const rec: CloneRecord = {
        clone_id: input.clone_id,
        mode: input.mode,
        parent_pid: input.parent_pid,
        worktree: input.worktree,
        metadata: input.metadata,
        registered_at: now,
        last_heartbeat_at: now,
        state: 'STARTING',
      };
      now += 1;
      records.push(rec);
      return rec;
    },
    async touch(cloneId) {
      // bug #66: booting heartbeat — refresh last_heartbeat_at without changing state.
      const rec = records.find((r) => r.clone_id === cloneId);
      if (!rec || rec.state === 'DEAD') return;
      rec.last_heartbeat_at = now++;
    },
    async recordClonePid(cloneId, pid) {
      // #65: persist the clone's own pid after launch; records even on DEAD so a
      // reaper that fired between register and this call can't orphan the pid.
      // Only an absent record is a no-op.
      const rec = records.find((r) => r.clone_id === cloneId);
      if (!rec) return;
      rec.clone_pid = pid;
    },
    async getState(cloneId) {
      // bug #70: non-throwing state read for the booting-ticker.
      return records.find((r) => r.clone_id === cloneId)?.state ?? null;
    },
    async markDead(cloneId, reason) {
      if (opts.onMarkDead) await opts.onMarkDead(cloneId);
      const rec = records.find((r) => r.clone_id === cloneId);
      if (!rec) throw new Error(`not found: ${cloneId}`);
      rec.state = 'DEAD';
      rec.death_reason = reason;
      rec.died_at = now++;
      return rec;
    },
    get(cloneId) {
      const rec = records.find((r) => r.clone_id === cloneId);
      return rec
        ? Promise.resolve(rec)
        : Promise.reject(new Error(`not found: ${cloneId}`));
    },
  };
}
