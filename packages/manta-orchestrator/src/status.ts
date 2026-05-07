import type { BusContext, CloneRecord, LockLease, WorkClaim } from '@manta/bus';
import type { Thresholds } from './thresholds';

export interface OrchestratorStatus {
  now: number;
  clones: CloneRecord[];
  locks: LockLease[];
  claims: WorkClaim[];
  thresholds: Thresholds;
}

export async function buildStatus(
  ctx: Pick<BusContext, 'registry' | 'locks' | 'claims' | 'clock'>,
  options: { thresholds: Thresholds },
): Promise<OrchestratorStatus> {
  const [clones, locks, claims] = await Promise.all([
    ctx.registry.list(),
    listLeases(ctx),
    ctx.claims.list(),
  ]);
  return {
    now: ctx.clock.now(),
    clones,
    locks,
    claims,
    thresholds: options.thresholds,
  };
}

async function listLeases(ctx: Pick<BusContext, 'locks' | 'registry'>): Promise<LockLease[]> {
  // LocksStore exposes listOwned(cloneId); aggregate across all known clones.
  // (A LocksStore.listAll would be cleaner; defer until Phase 0d when CLI surfaces it.)
  const all = await ctx.registry.list();
  const out: LockLease[] = [];
  for (const c of all) {
    const owned = await ctx.locks.listOwned(c.clone_id);
    out.push(...owned);
  }
  return out;
}
