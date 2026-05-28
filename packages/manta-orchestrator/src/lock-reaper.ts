import type { BusContext, BusEvent, LockLease } from '@manta/bus';

export interface ReapLocksResult {
  reaped: LockLease[];
  events: BusEvent[];
}

/**
 * Reap stale leases and emit one `lock_reap` audit event per lease.
 *
 * Bug #24: the audit append now lives **inside** the locks.json file mutex
 * via `LocksStore.reapStale`'s `auditAppend` closure. A crash between the
 * tmp+rename commit and the audit append used to silently lose the
 * forensic record of who lost which lease; now `events.append` is invoked
 * before `atomicMutateJson` commits, so either both land or neither does.
 *
 * If `events.append` throws, the rename is aborted and the leases stay in
 * `locks.json` to be retried on the next reap pass.
 */
export async function reapLocks(
  ctx: Pick<BusContext, 'locks' | 'events'>,
): Promise<ReapLocksResult> {
  const events: BusEvent[] = [];
  const reaped = await ctx.locks.reapStale(async (leases) => {
    for (const lease of leases) {
      events.push(
        await ctx.events.append({
          type: 'lock_reap',
          clone_id: lease.owner_clone_id,
          payload: {
            path: lease.path,
            former_owner: lease.owner_clone_id,
            last_heartbeat_at: lease.last_heartbeat_at,
          },
        }),
      );
    }
  });
  return { reaped, events };
}
