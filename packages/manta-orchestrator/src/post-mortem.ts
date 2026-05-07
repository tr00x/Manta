import type { BusContext, BusEvent, CloneRecord } from '@manta/bus';
import type { Thresholds } from './thresholds';
import type { PostMortemWriter, PostMortemDocument } from './post-mortem-writer';

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
  let final: CloneRecord = record;
  if (record.state !== 'DEAD') {
    final = await ctx.registry.markDead(opts.cloneId, opts.reason);
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
    lines.push('## Metadata');
    for (const [k, v] of Object.entries(input.record.metadata)) {
      lines.push(`- ${k}: ${v}`);
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
      lines.push(`- \`${e.ts}\` [${e.type}] ${JSON.stringify(e.payload)}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}
