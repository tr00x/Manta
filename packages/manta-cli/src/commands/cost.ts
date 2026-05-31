import type { Runtime } from '../runtime.js';
import type { Reporter } from '../output/reporter.js';
import type { CommandResult } from './status.js';
import type { ChargeEvent, DailySpendState } from '@manta/bus';
import { loadBudgetConfig } from '../config/budget-config.js';
import { CliError } from '../errors.js';

export type CostPeriod = 'today' | 'week';

export interface CostCommandOptions {
  period?: CostPeriod;
  reporter: Reporter;
}

/**
 * Normalise the raw `[period]` CLI argument to a `CostPeriod`.
 *
 * M3: the bin previously did `period === 'week' ? 'week' : 'today'`, so the
 * exact token `week` worked but `weekly` — and every other unrecognised value —
 * silently collapsed to the daily report. `manta cost weekly` therefore behaved
 * identically to `manta cost`, with no signal that the period arg was ignored.
 * Accept the natural daily/weekly spellings, and reject anything else loudly
 * (exit 1) instead of pretending it meant "today".
 */
export function normalizeCostPeriod(raw: string | undefined): CostPeriod {
  if (raw === undefined) return 'today';
  switch (raw.trim().toLowerCase()) {
    case '':
    case 'today':
    case 'day':
    case 'daily':
      return 'today';
    case 'week':
    case 'weekly':
      return 'week';
    default:
      throw new CliError(
        `unknown cost period "${raw}"; expected "today" (default) or "weekly"`,
        { kind: 'invalid_input' },
      );
  }
}

function progressBar(fraction: number, width = 20): string {
  const filled = Math.round(Math.min(fraction, 1) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const period = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 || 12;
  return `${h12}:${m}${period}`;
}

function truncateMode(mode: string, len = 15): string {
  return mode.length > len ? mode.slice(0, len - 1) + '.' : mode.padEnd(len);
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `~${(tokens / 1_000_000).toFixed(1)}M tok`;
  if (tokens >= 1_000) return `~${Math.round(tokens / 1_000)}k tok`;
  return `~${Math.round(tokens)} tok`;
}

async function renderToday(rt: Runtime, opts: CostCommandOptions): Promise<string> {
  const config = await loadBudgetConfig(rt.repoRoot);
  const dailyState: DailySpendState = await rt.ctx.dailySpend.read();
  const chargeState = await rt.ctx.charges.read();

  // Usage-aware view (budget repivot). Claude Code is a subscription, not pay-
  // per-token, so there is no dollar spend to show — the real signals are how
  // many casts/clones you ran and how much of your rolling rate budget remains.
  const castsToday = dailyState.entries.length;
  const clonesToday = dailyState.entries.reduce((n, e) => n + e.clone_count, 0);

  const oneHourAgo = Date.now() - 3_600_000;
  const log = await rt.ctx.charges.readLog();
  const castsLastHour = log.filter((e) => e.type === 'cast_start' && e.ts >= oneHourAgo).length;
  const rateRemaining = Math.max(0, config.maxCastsPerHour - castsLastHour);
  const rateFraction = config.maxCastsPerHour > 0 ? castsLastHour / config.maxCastsPerHour : 0;

  const lines: string[] = [];
  lines.push(`Usage today: ${castsToday} cast${castsToday !== 1 ? 's' : ''}, ${clonesToday} clone${clonesToday !== 1 ? 's' : ''} spawned`);
  lines.push(`Cast rate: ${castsLastHour}/${config.maxCastsPerHour} this hour  ${progressBar(rateFraction)}`);
  lines.push(`  ${rateRemaining} more cast${rateRemaining !== 1 ? 's' : ''} allowed before the hourly cap`);
  lines.push('');

  if (dailyState.entries.length === 0) {
    lines.push('No casts today.');
  } else {
    lines.push("Today's casts:");
    for (const e of dailyState.entries) {
      const castId = e.cast_id.length > 20 ? e.cast_id.slice(0, 20) : e.cast_id.padEnd(20);
      const mode = truncateMode(e.mode);
      const clones = `${e.clone_count} clone${e.clone_count !== 1 ? 's' : ''}`.padEnd(9);
      const usage = formatTokens(e.estimated_tokens).padEnd(10);
      const time = formatTime(e.started_at);
      lines.push(`  ${castId}  ${mode}  ${clones}  ${usage}  ${time}`);
    }
  }
  lines.push('');
  lines.push(`Token estimate today: ${formatTokens(dailyState.tokens_estimated)} (usage proxy, not dollars)`);
  lines.push(`Charges: ${chargeState.current_charges}/${chargeState.charges_max}  (parallelism cap: ${config.maxParallelClones} clones/cast)`);

  opts.reporter.info('cost.today', {
    casts: castsToday,
    clones: clonesToday,
    castsLastHour,
    tokensEstimated: dailyState.tokens_estimated,
  });

  return lines.join('\n');
}

async function renderWeek(rt: Runtime, opts: CostCommandOptions): Promise<string> {
  const log: ChargeEvent[] = await rt.ctx.charges.readLog();
  const now = Date.now();
  const oneWeekMs = 7 * 24 * 3600_000;
  const weekStart = now - oneWeekMs;

  const dailyState = await rt.ctx.dailySpend.read();

  // Per-day cast counts (usage signal), derived from today's ledger entries
  // plus the charge log's cast_start events across the week.
  const dayCasts = new Map<string, number>();
  for (const entry of dailyState.entries) {
    const dateKey = new Date(entry.started_at).toLocaleDateString('en-CA');
    dayCasts.set(dateKey, (dayCasts.get(dateKey) ?? 0) + 1);
  }

  const todayKey = new Date(now).toLocaleDateString('en-CA');
  const weekEvents = log.filter((e) => e.ts >= weekStart && e.type === 'cast_start');
  for (const ev of weekEvents) {
    const dateKey = new Date(ev.ts).toLocaleDateString('en-CA');
    // Today is already counted from the ledger; only the charge log carries
    // prior days (the daily ledger resets each calendar day).
    if (dateKey === todayKey) continue;
    dayCasts.set(dateKey, (dayCasts.get(dateKey) ?? 0) + 1);
  }

  let weekTotal = 0;
  for (const v of dayCasts.values()) weekTotal += v;

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayParts: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now - i * 24 * 3600_000);
    const key = d.toLocaleDateString('en-CA');
    const name = dayNames[d.getDay()];
    const count = dayCasts.get(key) ?? 0;
    dayParts.push(`${name} ${count}`);
  }

  const activeDays = dayCasts.size || 1;
  const avg = weekTotal / activeDays;

  const lines: string[] = [];
  lines.push(`This week: ${weekTotal} cast${weekTotal !== 1 ? 's' : ''}`);
  lines.push(`  ${dayParts.join('  ')}`);
  lines.push(`  Avg: ${avg.toFixed(1)} casts/active day`);

  opts.reporter.info('cost.week', { totalCasts: weekTotal, avg });

  return lines.join('\n');
}

export async function runCostCommand(
  rt: Runtime,
  opts: CostCommandOptions,
): Promise<CommandResult> {
  const stdout =
    opts.period === 'week' ? await renderWeek(rt, opts) : await renderToday(rt, opts);
  return { exitCode: 0, stdout };
}
