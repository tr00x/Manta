import {
  HeartbeatInputSchema,
  RegisterInputSchema,
  ReportDeathInputSchema,
  SuicideIntentInputSchema,
} from '../schema';
import type { BusContext } from './index';
import { parse } from './parse';
import type { CloneRecord } from '../state/registry';
import type { BusEvent } from '../state/events';

export interface LifecycleResult {
  clone: CloneRecord;
  event: BusEvent;
}

export interface LifecycleHandlers {
  register(input: unknown): Promise<LifecycleResult>;
  heartbeat(input: unknown): Promise<LifecycleResult>;
  suicideIntent(input: unknown): Promise<LifecycleResult>;
  reportDeath(input: unknown): Promise<LifecycleResult>;
}

export function createLifecycleHandlers(
  ctx: Pick<BusContext, 'registry' | 'events'>,
): LifecycleHandlers {
  return {
    async register(input) {
      const parsed = parse(RegisterInputSchema, input, 'register');
      // Couple the audit append to the registry mutation: the closure runs
      // inside the registry's file mutex BEFORE the state file is committed,
      // so an events.append failure aborts the mutation. See Fix #1 /
      // ARCHITECTURE.md "Audit-trail invariant".
      let event!: BusEvent;
      const clone = await ctx.registry.register(parsed, async () => {
        event = await ctx.events.append({
          type: 'register',
          clone_id: parsed.clone_id,
          payload: parsed,
        });
      });
      return { clone, event };
    },

    async heartbeat(input) {
      const parsed = parse(HeartbeatInputSchema, input, 'heartbeat');
      let event!: BusEvent;
      const clone = await ctx.registry.heartbeat(parsed, async () => {
        event = await ctx.events.append({
          type: 'heartbeat',
          clone_id: parsed.clone_id,
          payload: { state: parsed.state, progress: parsed.progress ?? null },
        });
      });
      return { clone, event };
    },

    async suicideIntent(input) {
      const parsed = parse(SuicideIntentInputSchema, input, 'suicide_intent');
      // suicide_intent is a state transition to WINDING_DOWN — not yet DEAD.
      // The orchestrator (Phase 0c) sees the WINDING_DOWN state plus the audit
      // event and decides whether to wait for the clone's report_death or
      // force-kill on a stall. The bus stays a pure data plane.
      let event!: BusEvent;
      const clone = await ctx.registry.heartbeat(
        { clone_id: parsed.clone_id, state: 'WINDING_DOWN' },
        async () => {
          event = await ctx.events.append({
            type: 'suicide_intent',
            clone_id: parsed.clone_id,
            payload: { reason: parsed.reason },
          });
        },
      );
      return { clone, event };
    },

    async reportDeath(input) {
      const parsed = parse(ReportDeathInputSchema, input, 'report_death');
      // markDead is the *only* legitimate path to the DEAD state — the
      // registry rejects DEAD via heartbeat (see registry.ts comments).
      let event!: BusEvent;
      const clone = await ctx.registry.markDead(
        parsed.clone_id,
        `report: ${parsed.last_gasp_report_path}`,
        async () => {
          event = await ctx.events.append({
            type: 'death',
            clone_id: parsed.clone_id,
            payload: { last_gasp_report_path: parsed.last_gasp_report_path },
          });
        },
      );
      return { clone, event };
    },
  };
}
