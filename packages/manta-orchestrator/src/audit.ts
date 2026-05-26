import type { BusEvent, CloneRecord } from '@manta/bus';

export interface AuditEntry {
  event: BusEvent;
  offsetMs: number;
  gapFromPreviousMs: number;
}

export interface GapAnomaly {
  fromEvent: BusEvent;
  toEvent: BusEvent;
  gapMs: number;
  offsetMs: number;
}

export interface AuditLog {
  cloneId: string;
  castId: string | null;
  mode: string;
  registeredAt: number;
  diedAt: number | null;
  deathReason: string | null;
  entries: AuditEntry[];
  gapAnomalies: GapAnomaly[];
  stats: {
    totalEvents: number;
    lifespanMs: number | null;
    avgGapMs: number | null;
    maxGapMs: number | null;
  };
}

export const EVENT_TYPE_GROUPS: Record<string, string[]> = {
  lifecycle: ['register', 'heartbeat', 'suicide_intent', 'death'],
  contract: ['contract_write', 'contract_ack', 'contract_refresh'],
  resources: ['lock', 'unlock', 'renew_lock', 'claim', 'release'],
  communication: ['broadcast', 'message', 'drift_report'],
  knowledge: ['zk_write', 'para_append'],
  orchestrator: ['post_mortem', 'lock_reap', 'claim_reap'],
};

export interface BuildAuditLogOptions {
  typeFilter?: string[] | undefined;
  since?: number | undefined;
  limit?: number | undefined;
  gapThresholdMs?: number | undefined;
}

export interface AuditBusContext {
  registry: { get(cloneId: string): Promise<CloneRecord> };
  events: { readAll(): Promise<BusEvent[]> };
}

function expandTypeFilter(filter: string[]): Set<string> {
  const result = new Set<string>();
  for (const f of filter) {
    const group = EVENT_TYPE_GROUPS[f];
    if (group) {
      for (const t of group) result.add(t);
    } else {
      result.add(f);
    }
  }
  return result;
}

export async function buildAuditLog(
  ctx: AuditBusContext,
  cloneId: string,
  opts?: BuildAuditLogOptions | undefined,
): Promise<AuditLog> {
  const record = await ctx.registry.get(cloneId);
  const castId = typeof record.metadata.cast_id === 'string'
    ? record.metadata.cast_id
    : null;
  const allEvents = await ctx.events.readAll();

  let filtered = allEvents.filter((e) => e.clone_id === cloneId);

  if (opts?.typeFilter != null && opts.typeFilter.length > 0) {
    const types = expandTypeFilter(opts.typeFilter);
    filtered = filtered.filter((e) => types.has(e.type));
  }

  if (opts?.since != null) {
    const since = opts.since;
    filtered = filtered.filter((e) => e.ts >= since);
  }

  if (opts?.limit != null && opts.limit > 0 && filtered.length > opts.limit) {
    filtered = filtered.slice(filtered.length - opts.limit);
  }

  const gapThresholdMs = opts?.gapThresholdMs ?? 30_000;
  const entries: AuditEntry[] = [];
  const gapAnomalies: GapAnomaly[] = [];
  let prevTs: number | null = null;
  let totalGap = 0;
  let maxGap = 0;

  for (const event of filtered) {
    const offsetMs = event.ts - record.registered_at;
    const gapFromPreviousMs = prevTs != null ? event.ts - prevTs : 0;
    entries.push({ event, offsetMs, gapFromPreviousMs });

    if (prevTs != null) {
      totalGap += gapFromPreviousMs;
      if (gapFromPreviousMs > maxGap) maxGap = gapFromPreviousMs;
      if (gapFromPreviousMs > gapThresholdMs) {
        gapAnomalies.push({
          fromEvent: filtered[entries.length - 2]!,
          toEvent: event,
          gapMs: gapFromPreviousMs,
          offsetMs,
        });
      }
    }
    prevTs = event.ts;
  }

  const lifespanMs =
    record.died_at != null ? record.died_at - record.registered_at : null;
  const gapCount = entries.length > 1 ? entries.length - 1 : 0;

  return {
    cloneId,
    castId,
    mode: record.mode,
    registeredAt: record.registered_at,
    diedAt: record.died_at ?? null,
    deathReason: record.death_reason ?? null,
    entries,
    gapAnomalies,
    stats: {
      totalEvents: entries.length,
      lifespanMs,
      avgGapMs: gapCount > 0 ? totalGap / gapCount : null,
      maxGapMs: gapCount > 0 ? maxGap : null,
    },
  };
}

function formatMs(ms: number): string {
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const rem = sec - min * 60;
  return `${min}m ${rem.toFixed(1)}s`;
}

function trunc(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  if (maxLen < 4) return '...'.slice(0, maxLen);
  return s.slice(0, maxLen - 3) + '...';
}

function payloadDetail(payload: unknown, maxLen: number): string {
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

export function renderAuditMarkdown(log: AuditLog): string {
  const lines: string[] = [];
  const castLabel = log.castId ? ` (${log.castId})` : '';
  lines.push(`# Audit — clone ${log.cloneId}${castLabel}`);
  lines.push('');
  lines.push(`- **Mode:** ${log.mode}`);
  lines.push(`- **Registered:** ${new Date(log.registeredAt).toISOString()}`);
  if (log.diedAt != null) {
    lines.push(`- **Died:** ${new Date(log.diedAt).toISOString()} — ${log.deathReason ?? 'unknown'}`);
  }
  lines.push('');

  if (log.entries.length === 0) {
    lines.push('_(no events)_');
    lines.push('');
  } else {
    lines.push('## Events');
    lines.push('');
    lines.push('| Offset | Type | Detail | Gap |');
    lines.push('|--------|------|--------|-----|');
    for (const entry of log.entries) {
      const offset = `+${formatMs(Math.max(0, entry.offsetMs))}`;
      const detail = payloadDetail(entry.event.payload, 80);
      const gap = entry.gapFromPreviousMs > 0
        ? formatMs(entry.gapFromPreviousMs)
        : '—';
      lines.push(`| ${offset} | ${entry.event.type} | ${detail} | ${gap} |`);
    }
    lines.push('');
  }

  if (log.gapAnomalies.length > 0) {
    lines.push('## Gap Anomalies');
    lines.push('');
    for (const g of log.gapAnomalies) {
      lines.push(
        `- **${formatMs(g.gapMs)} gap** between ` +
        `${g.fromEvent.type} and ${g.toEvent.type} at +${formatMs(Math.max(0, g.offsetMs))}`,
      );
    }
    lines.push('');
  }

  lines.push('## Statistics');
  lines.push('');
  lines.push(`- **Total events:** ${log.stats.totalEvents}`);
  lines.push(`- **Lifespan:** ${log.stats.lifespanMs != null ? formatMs(log.stats.lifespanMs) : '—'}`);
  lines.push(`- **Avg gap:** ${log.stats.avgGapMs != null ? formatMs(log.stats.avgGapMs) : '—'}`);
  lines.push(`- **Max gap:** ${log.stats.maxGapMs != null ? formatMs(log.stats.maxGapMs) : '—'}`);
  lines.push('');

  return lines.join('\n');
}

export function renderAuditJson(log: AuditLog): AuditLog {
  return log;
}
