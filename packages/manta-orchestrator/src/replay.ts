import type { BusEvent, CastManifest, CloneRecord } from '@manta/bus';
import { BusNotFoundError } from '@manta/bus';

export type ReplayPhase = 'spawn' | 'working' | 'death' | 'review';

export interface ReplayEvent {
  phase: ReplayPhase;
  event: BusEvent;
  offsetMs: number;
}

export interface ReplayCloneSummary {
  clone_id: string;
  registeredOffsetMs: number | null;
  firstHeartbeatOffsetMs: number | null;
  diedOffsetMs: number | null;
  lifespanMs: number | null;
  deathReason: string | null;
}

export interface ReplayTimeline {
  castId: string;
  mode: string;
  cloneIds: string[];
  createdAt: number;
  events: ReplayEvent[];
  cloneSummaries: ReplayCloneSummary[];
  mergeReviewVerdict: string | null;
  postMortemPaths: string[];
}

const SPAWN_TYPES = new Set(['contract_write', 'register']);
const DEATH_TYPES = new Set(['suicide_intent', 'death', 'post_mortem', 'lock_reap', 'claim_reap']);
const REVIEW_TYPES = new Set(['merge_review', 'promote']);

function classifyPhase(eventType: string): ReplayPhase {
  if (SPAWN_TYPES.has(eventType)) return 'spawn';
  if (DEATH_TYPES.has(eventType)) return 'death';
  if (REVIEW_TYPES.has(eventType)) return 'review';
  return 'working';
}

export function formatOffsetSeconds(baseTs: number, eventTs: number): string {
  const diffMs = Math.max(0, eventTs - baseTs);
  const totalSec = diffMs / 1000;
  if (totalSec < 60) return `+${totalSec.toFixed(1)}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec - min * 60;
  return `+${min}m ${sec.toFixed(1)}s`;
}

export interface ReplayBusContext {
  casts: { read(castId: string): Promise<CastManifest> };
  registry: { get(cloneId: string): Promise<CloneRecord> };
  events: { readAll(): Promise<BusEvent[]> };
}

export interface ReconstructTimelineOptions {
  cloneId?: string | undefined;
  since?: number | undefined;
}

export async function reconstructTimeline(
  ctx: ReplayBusContext,
  castId: string,
  opts?: ReconstructTimelineOptions | undefined,
): Promise<ReplayTimeline> {
  const manifest = await ctx.casts.read(castId);
  const rosterIds = new Set(manifest.clones.map((c) => c.clone_id));

  const allEvents = await ctx.events.readAll();
  let filtered = allEvents.filter((e) => {
    if (e.clone_id != null && rosterIds.has(e.clone_id)) return true;
    const payload = e.payload as Record<string, unknown> | null;
    if (payload?.cast_id === castId && REVIEW_TYPES.has(e.type)) return true;
    return false;
  });

  if (opts?.cloneId) {
    const targetClone = opts.cloneId;
    filtered = filtered.filter(
      (e) => e.clone_id === undefined || e.clone_id === targetClone,
    );
  }

  if (opts?.since != null) {
    const since = opts.since;
    filtered = filtered.filter((e) => e.ts >= since);
  }

  const events: ReplayEvent[] = filtered.map((e) => ({
    phase: classifyPhase(e.type),
    event: e,
    offsetMs: e.ts - manifest.created_at,
  }));

  const cloneIds = manifest.clones.map((c) => c.clone_id);
  const activeIds = opts?.cloneId ? [opts.cloneId] : cloneIds;
  const cloneSummaries: ReplayCloneSummary[] = [];

  for (const id of activeIds) {
    let record: CloneRecord | null = null;
    try {
      record = await ctx.registry.get(id);
    } catch (err) {
      if (!(err instanceof BusNotFoundError)) throw err;
    }
    const registerEvent = allEvents.find(
      (e) => e.clone_id === id && e.type === 'register',
    );
    const heartbeatEvent = allEvents.find(
      (e) => e.clone_id === id && e.type === 'heartbeat',
    );
    const registeredOffsetMs = registerEvent
      ? registerEvent.ts - manifest.created_at
      : null;
    const firstHeartbeatOffsetMs = heartbeatEvent
      ? heartbeatEvent.ts - manifest.created_at
      : null;
    const diedOffsetMs =
      record?.died_at != null ? record.died_at - manifest.created_at : null;
    const lifespanMs =
      record?.died_at != null
        ? record.died_at - record.registered_at
        : null;
    cloneSummaries.push({
      clone_id: id,
      registeredOffsetMs,
      firstHeartbeatOffsetMs,
      diedOffsetMs,
      lifespanMs,
      deathReason: record?.death_reason ?? null,
    });
  }

  const mergeReviewEvent = filtered.find((e) => e.type === 'merge_review');
  const mergeReviewVerdict = mergeReviewEvent
    ? ((mergeReviewEvent.payload as Record<string, unknown> | null)?.verdict as string) ?? null
    : null;

  const postMortemPaths = filtered
    .filter((e) => e.type === 'post_mortem')
    .map((e) => ((e.payload as Record<string, unknown> | null)?.path as string) ?? '')
    .filter((p) => p.length > 0);

  return {
    castId,
    mode: manifest.mode,
    cloneIds,
    createdAt: manifest.created_at,
    events,
    cloneSummaries,
    mergeReviewVerdict,
    postMortemPaths,
  };
}

function trunc(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  if (maxLen < 4) return '...'.slice(0, maxLen);
  return s.slice(0, maxLen - 3) + '...';
}

function payloadSummary(payload: unknown, maxLen: number): string {
  if (payload == null) return '';
  if (typeof payload !== 'object') return trunc(String(payload), maxLen);
  const obj = payload as Record<string, unknown>;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') parts.push(`${k}="${v}"`);
    else if (typeof v === 'number' || typeof v === 'boolean') parts.push(`${k}=${v}`);
    else parts.push(`${k}=${JSON.stringify(v)}`);
  }
  return trunc(parts.join(' '), maxLen);
}

export function renderReplayMarkdown(timeline: ReplayTimeline): string {
  const lines: string[] = [];
  lines.push(`# Cast Replay: ${timeline.castId}`);
  lines.push('');
  lines.push(`- **Mode:** ${timeline.mode}`);
  lines.push(`- **Clones:** ${timeline.cloneIds.join(', ')}`);
  lines.push(`- **Created:** ${new Date(timeline.createdAt).toISOString()}`);
  if (timeline.mergeReviewVerdict) {
    lines.push(`- **Merge verdict:** ${timeline.mergeReviewVerdict}`);
  }
  if (timeline.postMortemPaths.length > 0) {
    lines.push(`- **Post-mortems:** ${timeline.postMortemPaths.join(', ')}`);
  }
  lines.push('');

  const phases: ReplayPhase[] = ['spawn', 'working', 'death', 'review'];
  for (const phase of phases) {
    const phaseEvents = timeline.events.filter((e) => e.phase === phase);
    if (phaseEvents.length === 0) continue;
    lines.push(`## Phase: ${phase}`);
    lines.push('');
    lines.push('| Offset | Clone | Type | Payload |');
    lines.push('|--------|-------|------|---------|');
    for (const re of phaseEvents) {
      const offset = formatOffsetSeconds(timeline.createdAt, re.event.ts);
      const clone = re.event.clone_id ?? '—';
      const detail = payloadSummary(re.event.payload, 80);
      lines.push(`| ${offset} | ${clone} | ${re.event.type} | ${detail} |`);
    }
    lines.push('');
  }

  lines.push('## Clone Summaries');
  lines.push('');
  lines.push('| Clone | Registered | First HB | Died | Lifespan | Death Reason |');
  lines.push('|-------|-----------|----------|------|----------|--------------|');
  for (const s of timeline.cloneSummaries) {
    const reg = s.registeredOffsetMs != null ? formatOffsetSeconds(0, s.registeredOffsetMs) : '—';
    const hb = s.firstHeartbeatOffsetMs != null ? formatOffsetSeconds(0, s.firstHeartbeatOffsetMs) : '—';
    const died = s.diedOffsetMs != null ? formatOffsetSeconds(0, s.diedOffsetMs) : '—';
    const span = s.lifespanMs != null ? `${(s.lifespanMs / 1000).toFixed(1)}s` : '—';
    lines.push(`| ${s.clone_id} | ${reg} | ${hb} | ${died} | ${span} | ${s.deathReason ?? '—'} |`);
  }
  lines.push('');

  return lines.join('\n');
}

export function renderReplayJson(timeline: ReplayTimeline): ReplayTimeline {
  return timeline;
}
