import { ClaimWorkInputSchema, EnqueueWorkInputSchema, ReleaseWorkInputSchema } from '../schema';
import type { BusContext } from './index';
import { parse } from './parse';
import { BusForkingIsolationError } from '../errors';
import type { BusEvent } from '../state/events';
import type { WorkClaim } from '../state/claims';
import type { WorkItem } from '../state/work-queue';

export interface WorkHandlers {
  claim(input: unknown): Promise<{ claim: WorkClaim; event: BusEvent }>;
  release(input: unknown): Promise<{ event: BusEvent }>;
  enqueue(input: unknown): Promise<{ item: WorkItem; event: BusEvent }>;
}

export function createWorkHandlers(
  ctx: Pick<BusContext, 'claims' | 'events' | 'registry' | 'workQueue'>,
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

    async enqueue(input) {
      const parsed = parse(EnqueueWorkInputSchema, input, 'enqueue_work');
      if (!ctx.workQueue) {
        throw new Error('WorkQueueStore not initialized');
      }
      const item = await ctx.workQueue.enqueue({
        cast_id: parsed.cast_id,
        target_clone_id: parsed.target_clone_id,
        prompt: parsed.prompt,
        priority: parsed.priority,
      });
      const event = await ctx.events.append({
        type: 'enqueue_work',
        clone_id: parsed.target_clone_id,
        payload: { item_id: item.id, cast_id: parsed.cast_id, priority: parsed.priority },
      });
      return { item, event };
    },
  };
}
