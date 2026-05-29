import type { BusContext, BusEvent, CloneRecord } from '@manta/bus';
import type { Thresholds } from './thresholds';
import type { PostMortemWriter, PostMortemDocument } from './post-mortem-writer';
import { redactPostMortemMetadata } from './sanitize/metadata-allowlist';

export interface RunPostMortemOptions {
  cloneId: string;
  reason: string;
  writer: PostMortemWriter;
  thresholds: Thresholds;
}

export interface RunPostMortemResult {
  document: PostMortemDocument;
  event: BusEvent;
  path: string;
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

function ymd(epochMs: number): string {
  const d = new Date(epochMs);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function castIdOf(record: CloneRecord): string {
  const cast = record.metadata?.cast_id?.replace(/[^A-Za-z0-9._-]/g, '') ?? '';
  return cast.length > 0 ? cast : 'no-cast';
}

export async function runPostMortem(
  ctx: Pick<BusContext, 'registry' | 'events' | 'clock'>,
  opts: RunPostMortemOptions,
): Promise<RunPostMortemResult> {
  const record = await ctx.registry.get(opts.cloneId);

  // Mark DEAD if not already; preserves the original death_reason on idempotent re-runs.
  // Bug #41 fix: pass an auditAppend closure so the `reaped` event is appended
  // INSIDE the same file mutex as the markDead state mutation. Without this,
  // a crash between markDead's rename and the post_mortem event append would
  // leave the registry showing DEAD with no corresponding death event in
  // events.jsonl — the exact "state ahead of audit" inconsistency #24 was
  // built to prevent. We use `reaped` (not `death`) to distinguish
  // orchestrator-initiated termination from clone-self-reported death (which
  // the lifecycle handler emits as `death`).
  let final: CloneRecord = record;
  if (record.state !== 'DEAD') {
    // Bug #38 fix: pass the observed last_heartbeat_at so markDead can
    // re-check inside its mutex. If a heartbeat landed between the orchestrator's
    // findDeadClones() (which read `record` outside any lock) and this call,
    // markDead throws BusConflictError — `runPostMortem` propagates it and
    // the orchestrator's per-iteration catch skips both the DEAD-mark and
    // the post-mortem doc. Marking a live clone DEAD locks it off the bus
    // permanently (heartbeats reject DEAD), so the conservative path on any
    // detection-vs-mutation race is to abort.
    final = await ctx.registry.markDead(
      opts.cloneId,
      opts.reason,
      async () => {
        await ctx.events.append({
          type: 'reaped',
          clone_id: opts.cloneId,
          payload: { reason: opts.reason },
        });
      },
      record.last_heartbeat_at,
    );
  }

  const allEvents = await ctx.events.readAll();
  const cloneEvents = allEvents.filter((e) => e.clone_id === opts.cloneId);

  const day = ymd(ctx.clock.now());
  const cast = castIdOf(final);
  const filename = `${day}-${cast}-${opts.cloneId}.md`;

  const body = renderMarkdown({ record: final, reason: opts.reason, events: cloneEvents, thresholds: opts.thresholds });
  const document: PostMortemDocument = { filename, body };
  const written = await opts.writer.write(document);
  const event = await ctx.events.append({
    type: 'post_mortem',
    clone_id: opts.cloneId,
    payload: { path: written.path, reason: opts.reason },
  });
  return { document, event, path: written.path };
}

interface RenderInput {
  record: CloneRecord;
  reason: string;
  events: BusEvent[];
  thresholds: Thresholds;
}

function renderMarkdown(input: RenderInput): string {
  const lines: string[] = [];
  lines.push(`# Post-mortem — clone ${input.record.clone_id}`);
  lines.push('');
  lines.push(`- Mode: ${input.record.mode}`);
  lines.push(`- Worktree: ${input.record.worktree}`);
  lines.push(`- Parent PID: ${input.record.parent_pid}`);
  lines.push(`- Registered at (epoch ms): ${input.record.registered_at}`);
  lines.push(`- Last heartbeat at (epoch ms): ${input.record.last_heartbeat_at}`);
  lines.push(`- Died at (epoch ms): ${input.record.died_at ?? 'unknown'}`);
  lines.push(`- Final state: ${input.record.state}`);
  lines.push(`- Reason: ${input.reason}`);
  lines.push(`- Recorded death_reason: ${input.record.death_reason ?? '<none>'}`);
  lines.push('');
  if (Object.keys(input.record.metadata).length > 0) {
    const { kept, dropped } = redactPostMortemMetadata(input.record.metadata);
    lines.push('## Metadata');
    for (const [k, v] of Object.entries(kept)) {
      lines.push(`- ${k}: ${v}`);
    }
    if (dropped.length > 0) {
      lines.push(`- Dropped ${dropped.length} non-allowlisted metadata fields: ${dropped.join(', ')}`);
    }
    lines.push('');
  }
  lines.push('## Thresholds in effect');
  lines.push(`- heartbeatTimeoutMs: ${input.thresholds.heartbeatTimeoutMs}`);
  lines.push(`- startupGraceMs: ${input.thresholds.startupGraceMs}`);
  lines.push(`- staleLockMs: ${input.thresholds.staleLockMs}`);
  lines.push(`- parentPidCheckEnabled: ${input.thresholds.parentPidCheckEnabled}`);
  lines.push('');
  lines.push('## Event timeline');
  if (input.events.length === 0) {
    lines.push('- (no events recorded)');
  } else {
    for (const e of input.events) {
      const summary = renderEventPayload(e);
      lines.push(`- \`${e.ts}\` [${e.type}]${summary ? ' ' + summary : ''}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Type-aware payload projection for the post-mortem event timeline (bug #29).
 *
 * Pre-fix, `JSON.stringify(e.payload)` dumped the entire payload verbatim —
 * `broadcast.body`, `message.body`, `drift_report.evidence`,
 * `feedback.feedback`, `contract_ack.interpretation` are all unconstrained
 * free-form strings any clone can stuff with stderr, secrets, or arbitrary
 * exfil. Post-mortems are then bundled by `manta share` (Phase 7), so a leak
 * here ships externally.
 *
 * Fix: per-type allowlist of safe metadata fields. Free-form fields are
 * dropped unconditionally. Unknown event types render as `<payload omitted>`
 * (default-deny) so the safety contract holds even when new event types are
 * added without explicitly extending this projection.
 */
function renderEventPayload(e: BusEvent): string {
  const p = e.payload as Record<string, unknown> | null;
  if (!p || typeof p !== 'object') return '';
  switch (e.type) {
    case 'register':
      return summarize(p, ['mode']);
    case 'heartbeat':
      // Bug #46 fix: dropped `progress` from the allowlist. `progress` is
      // free-form clone-supplied text bounded only by `z.string().max(2000)`
      // — 2000 chars holds an entire API key or OAuth token. Post-mortems
      // are bundled externally by `manta share` (the documented leak path
      // for #29), so any secret a clone happened to put in `progress` would
      // leak. Operators who need the live progress trail can read it via
      // `manta inspect <cloneId>` on the running bus state; the post-mortem
      // doc is the wrong layer to surface free-form clone text at all.
      // Default-deny posture is now uniform across every event type.
      return summarize(p, ['state']);
    case 'broadcast':
      return summarize(p, ['event_type']); // body omitted
    case 'message':
      return summarize(p, ['to', 'channel']); // body omitted
    case 'drift_report':
      return summarize(p, ['drift_score']); // evidence omitted
    case 'feedback':
      return summarize(p, ['severity']); // feedback text omitted
    case 'claim':
    case 'release':
    case 'enqueue_work':
      return summarize(p, ['item', 'target']);
    case 'lock':
    case 'unlock':
    case 'renew_lock':
      return summarize(p, ['path']);
    case 'death':
    case 'reaped':
      return summarize(p, ['reason', 'last_gasp_report_path']);
    case 'post_mortem':
      return summarize(p, ['path', 'reason']);
    case 'retask':
      // task summary is operator-supplied free-form — drop.
      return '';
    case 'contract_write':
    case 'contract_ack':
    case 'contract_refresh':
      // interpretation/contract body is free-form — drop.
      return '';
    case 'suicide_intent':
    case 'pause':
    case 'resume':
    case 'request_task':
      return ''; // control events with no operator-needed payload surface
    case 'zk_write':
    case 'para_append':
      // note content is free-form — only structural markers safe to surface.
      return summarize(p, ['note_id', 'folder']);
    case 'cast_start':
    case 'cast_success':
    case 'cast_fail':
    case 'cast_neutral':
      return summarize(p, ['cast_id', 'mode', 'amount']);
    default:
      return '<payload omitted>';
  }
}

function summarize(p: Record<string, unknown>, keys: string[]): string {
  const projection: Record<string, unknown> = {};
  for (const k of keys) {
    if (k in p) projection[k] = p[k];
  }
  return Object.keys(projection).length === 0 ? '' : JSON.stringify(projection);
}
