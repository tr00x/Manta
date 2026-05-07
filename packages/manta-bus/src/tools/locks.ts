import { LockInputSchema } from '../schema';
import type { BusContext } from './index';
import { parse } from './parse';
import type { BusEvent } from '../state/events';
import type { LockLease } from '../state/locks';

export interface LockHandlers {
  lock(input: unknown): Promise<{ lease: LockLease; event: BusEvent }>;
  unlock(input: unknown): Promise<{ event: BusEvent }>;
  renew(input: unknown): Promise<{ lease: LockLease; event: BusEvent }>;
}

export function createLockHandlers(ctx: Pick<BusContext, 'locks' | 'events'>): LockHandlers {
  return {
    async lock(input) {
      const parsed = parse(LockInputSchema, input, 'lock');
      let event!: BusEvent;
      const lease = await ctx.locks.acquire(parsed, async () => {
        event = await ctx.events.append({
          type: 'lock',
          clone_id: parsed.clone_id,
          payload: { path: parsed.path },
        });
      });
      return { lease, event };
    },

    async unlock(input) {
      const parsed = parse(LockInputSchema, input, 'unlock');
      let event!: BusEvent;
      await ctx.locks.release(parsed, async () => {
        event = await ctx.events.append({
          type: 'unlock',
          clone_id: parsed.clone_id,
          payload: { path: parsed.path },
        });
      });
      return { event };
    },

    async renew(input) {
      const parsed = parse(LockInputSchema, input, 'renew_lock');
      let event!: BusEvent;
      const lease = await ctx.locks.renew(parsed, async () => {
        event = await ctx.events.append({
          type: 'renew_lock',
          clone_id: parsed.clone_id,
          payload: { path: parsed.path },
        });
      });
      return { lease, event };
    },
  };
}
