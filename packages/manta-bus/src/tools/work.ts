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
      // `expires_at` lives on the WorkClaim that the store computes inside its
      // mutator. The audit append runs in the same mutex BEFORE the state
      // commits, so we cannot reference `claim.expires_at` from the closure
      // (the WorkClaim is bound only after the rename). The contract is
      // `now + timeout_ms` and the store uses that exact formula — emit it
      // here against the event-log clock, which the mutator will match.
      let event!: BusEvent;
      const claim = await ctx.claims.claim(parsed, async () => {
        // ctx.events shares the same Clock as ctx.claims (created together
        // by createBusServer); ts on the BusEvent is the same value the
        // claims store will use for `claimed_at`, so `event.ts +
        // timeout_ms === claim.expires_at` by construction.
        event = await ctx.events.append({
          type: 'claim',
          clone_id: parsed.clone_id,
          payload: { item: parsed.item, timeout_ms: parsed.timeout_ms },
        });
      });
      return { claim, event };
    },

    async release(input) {
      const parsed = parse(ReleaseWorkInputSchema, input, 'release_work');
      let event!: BusEvent;
      await ctx.claims.release(parsed, async () => {
        event = await ctx.events.append({
          type: 'release',
          clone_id: parsed.clone_id,
          payload: { item: parsed.item },
        });
      });
      return { event };
    },
  };
}
