import { BroadcastInputSchema, DriftReportInputSchema, MessageInputSchema, ReadBroadcastsInputSchema } from '../schema';
import type { BusContext } from './index';
import { parse } from './parse';
import { siblingsInSameForkingCast } from './forking-isolation';
import { BusForkingIsolationError } from '../errors';
import type { BusEvent } from '../state/events';

export interface CommunicationHandlers {
  broadcast(input: unknown): Promise<{ event: BusEvent }>;
  message(input: unknown): Promise<{ event: BusEvent }>;
  driftReport(input: unknown): Promise<{ event: BusEvent }>;
  readBroadcasts(input: unknown): Promise<{ events: BusEvent[] }>;
}

export function createCommunicationHandlers(
  ctx: Pick<BusContext, 'events' | 'registry'>,
): CommunicationHandlers {
  return {
    async broadcast(input) {
      const parsed = parse(BroadcastInputSchema, input, 'broadcast');
      const r = await ctx.registry.get(parsed.clone_id);
      const event = await ctx.events.append({
        type: 'broadcast',
        clone_id: parsed.clone_id,
        payload: {
          event_type: parsed.event_type,
          body: parsed.payload,
          cast_id: r.metadata.cast_id ?? null,
          cast_mode: r.metadata.cast_mode ?? null,
        },
      });
      return { event };
    },

    async message(input) {
      const parsed = parse(MessageInputSchema, input, 'message');
      await Promise.all([
        ctx.registry.get(parsed.from_clone_id),
        ctx.registry.get(parsed.to_clone_id),
      ]);
      const sib = await siblingsInSameForkingCast(
        { registry: ctx.registry },
        parsed.from_clone_id,
        parsed.to_clone_id,
      );
      if (sib.same) {
        throw new BusForkingIsolationError({
          tool: 'manta.message',
          fromCloneId: parsed.from_clone_id,
          toCloneId: parsed.to_clone_id,
          castId: sib.castId,
        });
      }
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

    async readBroadcasts(input) {
      const parsed = parse(ReadBroadcastsInputSchema, input, 'read_broadcasts');
      const all = await ctx.events.readAll();
      const broadcasts = all.filter((e, idx) => {
        if (e.type !== 'broadcast') return false;
        if (e.clone_id === parsed.clone_id) return false;
        const payload = e.payload as Record<string, unknown> | null;
        if (payload?.cast_id !== parsed.cast_id) return false;
        if (parsed.since_index != null && idx < parsed.since_index) return false;
        return true;
      });
      return { events: broadcasts };
    },
  };
}
