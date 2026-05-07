import type { BusContext, BusEvent, LockLease } from '@manta/bus';

export interface ReapLocksResult {
  reaped: LockLease[];
  events: BusEvent[];
}

export async function reapLocks(
  ctx: Pick<BusContext, 'locks' | 'events'>,
): Promise<ReapLocksResult> {
  const reaped = await ctx.locks.reapStale();
  const events: BusEvent[] = [];
  for (const lease of reaped) {
    const event = await ctx.events.append({
      type: 'lock_reap',
      clone_id: lease.owner_clone_id,
      payload: {
        path: lease.path,
        former_owner: lease.owner_clone_id,
        last_heartbeat_at: lease.last_heartbeat_at,
      },
    });
    events.push(event);
  }
  return { reaped, events };
}
