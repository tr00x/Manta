import type { CloneRecord, RegisterInput } from '@manta/bus';

export interface RegistryFake {
  records: CloneRecord[];
  register(input: RegisterInput): Promise<CloneRecord>;
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
