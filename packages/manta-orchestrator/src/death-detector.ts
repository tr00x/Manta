import type { BusContext, CloneRecord } from '@manta/bus';
import type { Thresholds } from './thresholds';
import type { PidProbe } from './parent-pid';

export interface DeadCloneFinding {
  clone_id: string;
  record: CloneRecord;
  reason: string;
}

export interface FindDeadCloneOptions {
  thresholds: Thresholds;
  probe: PidProbe;
}

export async function findDeadClones(
  ctx: Pick<BusContext, 'registry' | 'clock'>,
  options: FindDeadCloneOptions,
): Promise<DeadCloneFinding[]> {
  const all = await ctx.registry.list();
  const now = ctx.clock.now();
  const out: DeadCloneFinding[] = [];
  for (const r of all) {
    if (r.state === 'DEAD') continue;
    const reasons: string[] = [];
    const sinceHeartbeat = now - r.last_heartbeat_at;
    if (sinceHeartbeat > options.thresholds.heartbeatTimeoutMs) {
      reasons.push(`heartbeat ${sinceHeartbeat}ms ago > ${options.thresholds.heartbeatTimeoutMs}ms`);
    }
    if (options.thresholds.parentPidCheckEnabled && !options.probe.alive(r.parent_pid)) {
      reasons.push(`parent pid ${r.parent_pid} not alive`);
    }
    if (reasons.length > 0) {
      out.push({ clone_id: r.clone_id, record: r, reason: reasons.join('; ') });
    }
  }
  return out;
}
