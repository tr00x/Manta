import type { BusEvent } from '@manta/bus';

let _seq = 0;

export function makeEvent(
  overrides: Partial<BusEvent> & Pick<BusEvent, 'type' | 'ts'>,
): BusEvent {
  const seq = _seq++;
  return {
    id: `${String(overrides.ts).padStart(13, '0')}-${String(seq).padStart(6, '0')}-test00`,
    clone_id: undefined,
    payload: null,
    ...overrides,
  };
}

export interface CastEventSequenceOptions {
  castId: string;
  cloneIds: string[];
  startTs: number;
  includeReview?: boolean;
  includePromote?: boolean;
}

export function createCastEventSequence(opts: CastEventSequenceOptions): BusEvent[] {
  const { castId, cloneIds, startTs } = opts;
  const includeReview = opts.includeReview ?? true;
  const includePromote = opts.includePromote ?? false;
  const events: BusEvent[] = [];
  let offset = 0;

  for (const id of cloneIds) {
    events.push(makeEvent({
      type: 'contract_write',
      ts: startTs + offset,
      clone_id: id,
      payload: { cast_id: castId, task: `task for ${id}` },
    }));
    offset += 100;
  }

  offset = 2000;
  for (const id of cloneIds) {
    events.push(makeEvent({
      type: 'register',
      ts: startTs + offset,
      clone_id: id,
      payload: { mode: 'forking-realities', cast_id: castId },
    }));
    offset += 1000;
  }

  offset = 6000;
  for (const id of cloneIds) {
    events.push(makeEvent({
      type: 'heartbeat',
      ts: startTs + offset,
      clone_id: id,
      payload: { state: 'WORKING' },
    }));
    offset += 1000;
  }

  offset = 6100;
  for (const id of cloneIds) {
    events.push(makeEvent({
      type: 'contract_ack',
      ts: startTs + offset,
      clone_id: id,
      payload: { cast_id: castId },
    }));
    offset += 1000;
  }

  events.push(makeEvent({
    type: 'lock',
    ts: startTs + 15_000,
    clone_id: cloneIds[0],
    payload: { path: 'src/auth.ts' },
  }));

  if (cloneIds.length > 1) {
    events.push(makeEvent({
      type: 'broadcast',
      ts: startTs + 45_000,
      clone_id: cloneIds[1],
      payload: { event_type: 'progress', message: 'halfway done' },
    }));
  }

  events.push(makeEvent({
    type: 'zk_write',
    ts: startTs + 78_000,
    clone_id: cloneIds[0],
    payload: { note: 'extracted validation logic' },
  }));

  events.push(makeEvent({
    type: 'unlock',
    ts: startTs + 80_000,
    clone_id: cloneIds[0],
    payload: { path: 'src/auth.ts' },
  }));

  offset = 120_000;
  for (const id of cloneIds) {
    events.push(makeEvent({
      type: 'suicide_intent',
      ts: startTs + offset,
      clone_id: id,
      payload: { reason: 'task complete' },
    }));
    offset += 5000;
  }

  offset = 121_000;
  for (const id of cloneIds) {
    events.push(makeEvent({
      type: 'death',
      ts: startTs + offset,
      clone_id: id,
      payload: { reason: 'task complete', cast_id: castId },
    }));
    offset += 5000;
  }

  offset = 121_500;
  for (const id of cloneIds) {
    events.push(makeEvent({
      type: 'post_mortem',
      ts: startTs + offset,
      clone_id: id,
      payload: { path: `docs/post-mortems/${castId}-${id}.md` },
    }));
    offset += 5000;
  }

  if (includeReview) {
    events.push(makeEvent({
      type: 'merge_review',
      ts: startTs + 180_000,
      clone_id: undefined,
      payload: {
        cast_id: castId,
        verdict: 'auto_merge_eligible',
        winner: cloneIds[0],
        scores: cloneIds.map((id) => ({ clone_id: id, score: id === cloneIds[0] ? 85 : 72 })),
      },
    }));
  }

  if (includePromote) {
    events.push(makeEvent({
      type: 'promote',
      ts: startTs + 200_000,
      clone_id: undefined,
      payload: { cast_id: castId, promoted_clone: cloneIds[0] },
    }));
  }

  return events;
}
