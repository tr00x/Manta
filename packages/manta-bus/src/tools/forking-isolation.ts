import type { BusContext } from './index';

export type SiblingCheck = { same: false } | { same: true; castId: string };

export async function siblingsInSameForkingCast(
  ctx: Pick<BusContext, 'registry'>,
  fromCloneId: string,
  toCloneId: string,
): Promise<SiblingCheck> {
  if (fromCloneId === toCloneId) return { same: false };
  const [from, to] = await Promise.all([
    ctx.registry.get(fromCloneId),
    ctx.registry.get(toCloneId),
  ]);
  if (from.metadata.cast_mode !== 'forking-realities') return { same: false };
  if (to.metadata.cast_mode !== 'forking-realities') return { same: false };
  const castId = from.metadata.cast_id;
  if (!castId) return { same: false };
  if (castId !== to.metadata.cast_id) return { same: false };
  return { same: true, castId };
}

export type CrossReadCheck = { blocked: false } | { blocked: true; castId: string };

export async function crossCloneRead(
  ctx: Pick<BusContext, 'registry'>,
  callerCloneId: string,
  targetCloneId: string,
): Promise<CrossReadCheck> {
  if (callerCloneId === targetCloneId) return { blocked: false };
  const caller = await ctx.registry.get(callerCloneId).catch(() => null);
  if (!caller) return { blocked: false };
  if (caller.metadata.cast_mode !== 'forking-realities') return { blocked: false };
  const castId = caller.metadata.cast_id;
  if (!castId) return { blocked: false };
  return { blocked: true, castId };
}
