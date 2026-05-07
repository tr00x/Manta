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
      // Audit-first: events.append runs BEFORE the filesystem write. If the
      // append fails, no file is created. The writer passes the computed
      // target path into the closure so the event records the intended path;
      // a failure between audit and write leaves the audit ahead of state
      // (orchestrator reconciles in Phase 0c). See ARCHITECTURE.md
      // "Audit-trail invariant".
      let event!: BusEvent;
      const result = await ctx.memoryWriters.zkWrite(parsed, async (computedPath) => {
        event = await ctx.events.append({
          type: 'zk_write',
          clone_id: parsed.clone_id,
          payload: { path: computedPath, title: parsed.title },
        });
      });
      return { path: result.path, event };
    },

    async paraAppend(input) {
      const parsed = parse(ParaAppendInputSchema, input, 'para_append');
      let event!: BusEvent;
      const result = await ctx.memoryWriters.paraAppend(parsed, async (computedPath) => {
        event = await ctx.events.append({
          type: 'para_append',
          clone_id: parsed.clone_id,
          payload: { path: computedPath, category: parsed.category },
        });
      });
      return { path: result.path, event };
    },
  };
}
