import type { BusContext, BusEvent, WorkClaim } from '@manta/bus';

export interface ReapClaimsResult {
  reaped: WorkClaim[];
  events: BusEvent[];
}

/**
 * Reap expired claims and emit one `claim_reap` audit event per claim.
 *
 * Bug #24: the audit append now lives **inside** the claims.json file mutex
 * via `ClaimsStore.reapExpired`'s `auditAppend` closure. If `events.append`
 * throws, the rename is aborted and the claims stay in `claims.json` to be
 * retried on the next reap pass — no orphan state mutation without a
 * forensic trail.
 */
export async function reapClaims(
  ctx: Pick<BusContext, 'claims' | 'events'>,
): Promise<ReapClaimsResult> {
  const events: BusEvent[] = [];
  const reaped = await ctx.claims.reapExpired(async (claims) => {
    for (const claim of claims) {
      events.push(
        await ctx.events.append({
          type: 'claim_reap',
          clone_id: claim.owner_clone_id,
          payload: {
            item: claim.item,
            former_owner: claim.owner_clone_id,
            expired_at: claim.expires_at,
          },
        }),
      );
    }
  });
  return { reaped, events };
}
