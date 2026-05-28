import { LockInputSchema } from '../schema';
import type { BusContext } from './index';
import { parse } from './parse';
import { BusForkingIsolationError } from '../errors';
import type { Registry } from '../state/registry';
import type { BusEvent } from '../state/events';
import type { LockLease } from '../state/locks';

export interface LockHandlers {
  lock(input: unknown): Promise<{ lease: LockLease; event: BusEvent }>;
  unlock(input: unknown): Promise<{ event: BusEvent }>;
  renew(input: unknown): Promise<{ lease: LockLease; event: BusEvent }>;
}

/**
 * Refuse the call for a forking-realities clone — bug #28.
 *
 * Symmetric to the FR-isolation guard on `manta.claim_work`
 * (`tools/work.ts`): FR-cast siblings live in isolated worktrees and share
 * no business-level resources, so the shared `.manta/state/locks.json`
 * collision between two siblings is structurally meaningless. Without this
 * guard, two FR siblings touching the same repo-relative path produce a
 * spurious `BusLockedError`.
 *
 * Unknown callers (not in registry) fall through silently — the dispatcher
 * is permissive for synthetic clone_ids used by tests and the daemon
 * runtime; matches the existing behavior in `work.ts`.
 */
async function refuseForkingRealities(
  registry: Registry,
  toolName: 'manta.lock' | 'manta.unlock' | 'manta.renew_lock',
  cloneId: string,
): Promise<void> {
  const r = await registry.get(cloneId).catch(() => null);
  if (!r) return;
  if (r.metadata.cast_mode !== 'forking-realities') return;
  const castId = r.metadata.cast_id ?? '<missing>';
  throw new BusForkingIsolationError({
    tool: toolName,
    fromCloneId: cloneId,
    castId,
  });
}

export function createLockHandlers(
  ctx: Pick<BusContext, 'locks' | 'events' | 'registry'>,
): LockHandlers {
  return {
    async lock(input) {
      const parsed = parse(LockInputSchema, input, 'lock');
      await refuseForkingRealities(ctx.registry, 'manta.lock', parsed.clone_id);
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
      await refuseForkingRealities(ctx.registry, 'manta.unlock', parsed.clone_id);
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
      await refuseForkingRealities(ctx.registry, 'manta.renew_lock', parsed.clone_id);
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
