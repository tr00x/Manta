import { ParaAppendInputSchema, ZkWriteInputSchema } from '../schema';
import type { BusContext } from './index';
import { parse } from './parse';
import type { BusEvent } from '../state/events';

export interface MemoryHandlers {
  zkWrite(input: unknown): Promise<{ path: string; event: BusEvent }>;
  paraAppend(input: unknown): Promise<{ path: string; event: BusEvent }>;
}

export function createMemoryHandlers(
  ctx: Pick<BusContext, 'events' | 'memoryWriters'>,
): MemoryHandlers {
  return {
    async zkWrite(input) {
      const parsed = parse(ZkWriteInputSchema, input, 'zk_write');
      const result = await ctx.memoryWriters.zkWrite(parsed);
      const event = await ctx.events.append({
        type: 'zk_write',
        clone_id: parsed.clone_id,
        payload: { path: result.path, title: parsed.title },
      });
      return { path: result.path, event };
    },

    async paraAppend(input) {
      const parsed = parse(ParaAppendInputSchema, input, 'para_append');
      const result = await ctx.memoryWriters.paraAppend(parsed);
      const event = await ctx.events.append({
        type: 'para_append',
        clone_id: parsed.clone_id,
        payload: { path: result.path, category: parsed.category },
      });
      return { path: result.path, event };
    },
  };
}
