import { ClaimWorkInputSchema, ReleaseWorkInputSchema } from '../schema';
import type { BusContext } from './index';
import { parse } from './parse';
import type { BusEvent } from '../state/events';
import type { WorkClaim } from '../state/claims';

export interface WorkHandlers {
  claim(input: unknown): Promise<{ claim: WorkClaim; event: BusEvent }>;
  release(input: unknown): Promise<{ event: BusEvent }>;
}

export function createWorkHandlers(ctx: Pick<BusContext, 'claims' | 'events'>): WorkHandlers {
  return {
    async claim(input) {
      const parsed = parse(ClaimWorkInputSchema, input, 'claim_work');
      const claim = await ctx.claims.claim(parsed);
      const event = await ctx.events.append({
        type: 'claim',
        clone_id: parsed.clone_id,
        payload: { item: parsed.item, expires_at: claim.expires_at },
      });
      return { claim, event };
    },

    async release(input) {
      const parsed = parse(ReleaseWorkInputSchema, input, 'release_work');
      await ctx.claims.release(parsed);
      const event = await ctx.events.append({
        type: 'release',
        clone_id: parsed.clone_id,
        payload: { item: parsed.item },
      });
      return { event };
    },
  };
}
