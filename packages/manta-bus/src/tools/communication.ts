import { BroadcastInputSchema, DriftReportInputSchema, MessageInputSchema } from '../schema';
import type { BusContext } from './index';
import { parse } from './parse';
import type { BusEvent } from '../state/events';

export interface CommunicationHandlers {
  broadcast(input: unknown): Promise<{ event: BusEvent }>;
  message(input: unknown): Promise<{ event: BusEvent }>;
  driftReport(input: unknown): Promise<{ event: BusEvent }>;
}

export function createCommunicationHandlers(
  ctx: Pick<BusContext, 'events' | 'registry'>,
): CommunicationHandlers {
  return {
    async broadcast(input) {
      const parsed = parse(BroadcastInputSchema, input, 'broadcast');
      const event = await ctx.events.append({
        type: 'broadcast',
        clone_id: parsed.clone_id,
        payload: { event_type: parsed.event_type, body: parsed.payload },
      });
      return { event };
    },

    async message(input) {
      const parsed = parse(MessageInputSchema, input, 'message');
      // Verify both clones are known — addressing a non-existent peer is a
      // structural error, not a policy decision (see ARCHITECTURE.md). The
      // registry's get() throws BusNotFoundError on miss, which the server's
      // serializeError maps to the `not_found` envelope.
      await ctx.registry.get(parsed.from_clone_id);
      await ctx.registry.get(parsed.to_clone_id);
      const event = await ctx.events.append({
        type: 'message',
        clone_id: parsed.from_clone_id,
        payload: { from: parsed.from_clone_id, to: parsed.to_clone_id, body: parsed.payload },
      });
      return { event };
    },

    async driftReport(input) {
      const parsed = parse(DriftReportInputSchema, input, 'drift_report');
      const event = await ctx.events.append({
        type: 'drift_report',
        clone_id: parsed.clone_id,
        payload: { score: parsed.score, evidence: parsed.evidence },
      });
      return { event };
    },
  };
}
