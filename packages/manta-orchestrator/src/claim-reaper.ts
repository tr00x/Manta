import type { BusContext, BusEvent, WorkClaim } from '@manta/bus';

export interface ReapClaimsResult {
  reaped: WorkClaim[];
  events: BusEvent[];
}

export async function reapClaims(
  ctx: Pick<BusContext, 'claims' | 'events'>,
): Promise<ReapClaimsResult> {
  const reaped = await ctx.claims.reapExpired();
  const events: BusEvent[] = [];
  for (const claim of reaped) {
    const event = await ctx.events.append({
      type: 'claim_reap',
      clone_id: claim.owner_clone_id,
      payload: {
        item: claim.item,
        former_owner: claim.owner_clone_id,
        expired_at: claim.expires_at,
      },
    });
    events.push(event);
  }
  return { reaped, events };
}
