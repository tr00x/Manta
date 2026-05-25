import { ClaimWorkInputSchema, ReleaseWorkInputSchema } from '../schema';
import type { BusContext } from './index';
import { parse } from './parse';
import { BusForkingIsolationError } from '../errors';
import type { BusEvent } from '../state/events';
import type { WorkClaim } from '../state/claims';

export interface WorkHandlers {
  claim(input: unknown): Promise<{ claim: WorkClaim; event: BusEvent }>;
  release(input: unknown): Promise<{ event: BusEvent }>;
}

export function createWorkHandlers(
  ctx: Pick<BusContext, 'claims' | 'events' | 'registry'>,
): WorkHandlers {
  return {
    async claim(input) {
      const parsed = parse(ClaimWorkInputSchema, input, 'claim_work');
      const r = await ctx.registry.get(parsed.clone_id);
      if (r.metadata.cast_mode === 'forking-realities') {
        const castId = r.metadata.cast_id;
        if (!castId) {
          throw new BusForkingIsolationError({
            tool: 'manta.claim_work',
            fromCloneId: parsed.clone_id,
            castId: '<missing>',
          });
        }
        throw new BusForkingIsolationError({
          tool: 'manta.claim_work',
          fromCloneId: parsed.clone_id,
          castId,
        });
      }
      let event!: BusEvent;
      const claim = await ctx.claims.claim(parsed, async () => {
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
