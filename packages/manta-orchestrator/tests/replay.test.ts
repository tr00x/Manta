import { describe, it, expect } from 'vitest';
import type { BusEvent, CastManifest, CloneRecord } from '@manta/bus';
import { BusNotFoundError } from '@manta/bus';
import { createCastEventSequence } from './fixtures/event-factory';
import {
  reconstructTimeline,
  renderReplayMarkdown,
  renderReplayJson,
  formatOffsetSeconds,
  type ReplayBusContext,
} from '../src/replay';

function makeCastManifest(overrides: Partial<CastManifest> = {}): CastManifest {
  return {
    version: 1,
    cast_id: 'cast-test-1',
    mode: 'forking-realities',
    clones: [
      { clone_id: 'A', assignment: null },
      { clone_id: 'B', assignment: null },
    ],
    policy: {
      peer_messaging: 'denied',
      auto_merge_threshold: null,
      session_mode: 'batch',
    },
    created_at: 1000,
    ...overrides,
  };
}

function makeCloneRecord(id: string, overrides: Partial<CloneRecord> = {}): CloneRecord {
  return {
    clone_id: id,
    mode: 'forking-realities',
    parent_pid: 1234,
    worktree: `/tmp/${id}`,
    metadata: { cast_id: 'cast-test-1' },
    registered_at: 3000,
    last_heartbeat_at: 6000,
    state: 'DEAD',
    death_reason: 'task complete',
    died_at: 122000,
    ...overrides,
  };
}

function makeCtx(opts: {
  manifest?: CastManifest | undefined;
  events?: BusEvent[] | undefined;
  records?: Record<string, CloneRecord> | undefined;
  castError?: Error | undefined;
} = {}): ReplayBusContext {
  const manifest = opts.manifest ?? makeCastManifest();
  const events = opts.events ?? createCastEventSequence({
    castId: manifest.cast_id,
    cloneIds: manifest.clones.map((c) => c.clone_id),
    startTs: manifest.created_at,
  });
  const records = opts.records ?? Object.fromEntries(
    manifest.clones.map((c) => [c.clone_id, makeCloneRecord(c.clone_id)]),
  );

  return {
    casts: {
      read: (id: string): Promise<CastManifest> => {
        if (opts.castError) return Promise.reject(opts.castError);
        if (id !== manifest.cast_id) return Promise.reject(new BusNotFoundError('cast', id));
        return Promise.resolve(manifest);
      },
    },
    registry: {
      get: (id: string): Promise<CloneRecord> => {
        const r = records[id];
        if (!r) return Promise.reject(new BusNotFoundError('clone', id));
        return Promise.resolve(r);
      },
    },
    events: {
      readAll: (): Promise<BusEvent[]> => Promise.resolve(events),
    },
  };
}

describe('formatOffsetSeconds', () => {
  it('formats zero offset', () => {
    expect(formatOffsetSeconds(1000, 1000)).toBe('+0.0s');
  });

  it('formats sub-minute offset', () => {
    expect(formatOffsetSeconds(1000, 46300)).toBe('+45.3s');
  });

  it('formats multi-minute offset', () => {
    expect(formatOffsetSeconds(1000, 136000)).toBe('+2m 15.0s');
  });

  it('formats exact minute boundary', () => {
    expect(formatOffsetSeconds(0, 60000)).toBe('+1m 0.0s');
  });
});

describe('reconstructTimeline', () => {
  it('filters events by roster clone_ids', async () => {
    const manifest = makeCastManifest();
    const rosterEvents = createCastEventSequence({
      castId: manifest.cast_id,
      cloneIds: ['A', 'B'],
      startTs: manifest.created_at,
    });
    const foreignEvent: BusEvent = {
      id: '0000000050000-000099-foreign',
      ts: 50000,
      type: 'heartbeat',
      clone_id: 'C',
      payload: { state: 'WORKING' },
    };
    const allEvents = [...rosterEvents, foreignEvent];
    const ctx = makeCtx({ manifest, events: allEvents });

    const timeline = await reconstructTimeline(ctx, 'cast-test-1');
    const cloneIdsInEvents = new Set(timeline.events.map((e) => e.event.clone_id));
    expect(cloneIdsInEvents.has('C')).toBe(false);
    expect(cloneIdsInEvents.has('A')).toBe(true);
    expect(cloneIdsInEvents.has('B')).toBe(true);
  });

  it('includes events with undefined clone_id (merge_review, promote)', async () => {
    const manifest = makeCastManifest();
    const events = createCastEventSequence({
      castId: manifest.cast_id,
      cloneIds: ['A', 'B'],
      startTs: manifest.created_at,
      includeReview: true,
      includePromote: true,
    });
    const ctx = makeCtx({ manifest, events });

    const timeline = await reconstructTimeline(ctx, 'cast-test-1');
    const reviewEvents = timeline.events.filter((e) => e.phase === 'review');
    expect(reviewEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('classifies phases correctly', async () => {
    const ctx = makeCtx();
    const timeline = await reconstructTimeline(ctx, 'cast-test-1');

    const phases = new Set(timeline.events.map((e) => e.phase));
    expect(phases.has('spawn')).toBe(true);
    expect(phases.has('working')).toBe(true);
    expect(phases.has('death')).toBe(true);
    expect(phases.has('review')).toBe(true);

    const spawnEvents = timeline.events.filter((e) => e.phase === 'spawn');
    for (const ev of spawnEvents) {
      expect(['contract_write', 'register']).toContain(ev.event.type);
    }

    const deathEvents = timeline.events.filter((e) => e.phase === 'death');
    for (const ev of deathEvents) {
      expect(['suicide_intent', 'death', 'post_mortem', 'lock_reap', 'claim_reap']).toContain(ev.event.type);
    }
  });

  it('applies clone filter', async () => {
    const ctx = makeCtx();
    const timeline = await reconstructTimeline(ctx, 'cast-test-1', { cloneId: 'A' });

    for (const ev of timeline.events) {
      if (ev.event.clone_id !== undefined) {
        expect(ev.event.clone_id).toBe('A');
      }
    }
  });

  it('applies since filter', async () => {
    const manifest = makeCastManifest();
    const ctx = makeCtx({ manifest });
    const sinceTs = manifest.created_at + 10000;
    const timeline = await reconstructTimeline(ctx, 'cast-test-1', { since: sinceTs });

    for (const ev of timeline.events) {
      expect(ev.event.ts).toBeGreaterThanOrEqual(sinceTs);
    }
  });

  it('computes clone summaries', async () => {
    const ctx = makeCtx();
    const timeline = await reconstructTimeline(ctx, 'cast-test-1');

    expect(timeline.cloneSummaries).toHaveLength(2);
    const summaryA = timeline.cloneSummaries.find((s) => s.clone_id === 'A');
    expect(summaryA).toBeDefined();
    expect(summaryA!.registeredOffsetMs).toBeTypeOf('number');
    expect(summaryA!.diedOffsetMs).toBeTypeOf('number');
    expect(summaryA!.lifespanMs).toBeTypeOf('number');
    expect(summaryA!.deathReason).toBe('task complete');
  });

  it('throws BusNotFoundError for unknown cast', async () => {
    const ctx = makeCtx();
    await expect(reconstructTimeline(ctx, 'cast-nonexistent')).rejects.toThrow(BusNotFoundError);
  });

  it('populates mergeReviewVerdict from review events', async () => {
    const ctx = makeCtx();
    const timeline = await reconstructTimeline(ctx, 'cast-test-1');
    expect(timeline.mergeReviewVerdict).toBe('auto_merge_eligible');
  });

  it('populates postMortemPaths from post_mortem events', async () => {
    const ctx = makeCtx();
    const timeline = await reconstructTimeline(ctx, 'cast-test-1');
    expect(timeline.postMortemPaths).toHaveLength(2);
    expect(timeline.postMortemPaths[0]).toContain('cast-test-1');
  });
});

describe('renderReplayMarkdown', () => {
  it('produces markdown with header and events', async () => {
    const ctx = makeCtx();
    const timeline = await reconstructTimeline(ctx, 'cast-test-1');
    const md = renderReplayMarkdown(timeline);

    expect(md).toContain('# Cast Replay');
    expect(md).toContain('cast-test-1');
    expect(md).toContain('forking-realities');
    expect(md).toContain('spawn');
    expect(md).toContain('working');
    expect(md).toContain('death');
    expect(md).toContain('## Clone Summaries');
  });
});

describe('renderReplayJson', () => {
  it('returns the timeline object', async () => {
    const ctx = makeCtx();
    const timeline = await reconstructTimeline(ctx, 'cast-test-1');
    const json = renderReplayJson(timeline);

    expect(json).toBe(timeline);
    expect(json.castId).toBe('cast-test-1');
    expect(json.events.length).toBeGreaterThan(0);
  });
});
