import type { Runtime } from '../runtime.js';
import type { Reporter } from '../output/reporter.js';
import type { CommandResult } from './status.js';
import type { ChargeEvent, DailySpendState } from '@manta/bus';
import { loadBudgetConfig } from '../config/budget-config.js';

export interface CostCommandOptions {
  period?: 'today' | 'week';
  reporter: Reporter;
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

async function renderToday(rt: Runtime, opts: CostCommandOptions): Promise<string> {
  const config = await loadBudgetConfig(rt.repoRoot);
  const dailyState: DailySpendState = await rt.ctx.dailySpend.read();
  const chargeState = await rt.ctx.charges.read();
  const remaining = Math.max(0, config.dailyCapUsd - dailyState.spent_usd);
  const fraction = config.dailyCapUsd > 0 ? dailyState.spent_usd / config.dailyCapUsd : 0;
  const pct = Math.round(fraction * 100);

  const lines: string[] = [];
  lines.push(
    `Daily budget: $${dailyState.spent_usd.toFixed(2)} / $${config.dailyCapUsd.toFixed(2)} (${pct}%)`,
  );
  lines.push(`${progressBar(fraction)} ${pct}%`);
  lines.push('');

  if (dailyState.entries.length === 0) {
    lines.push('No casts today.');
  } else {
    lines.push("Today's casts:");
    for (const e of dailyState.entries) {
      const castId = e.cast_id.length > 20 ? e.cast_id.slice(0, 20) : e.cast_id.padEnd(20);
      const mode = truncateMode(e.mode);
      const clones = `${e.clone_count} clone${e.clone_count !== 1 ? 's' : ''}`.padEnd(9);
      const cost = `~$${e.estimated_cost_usd.toFixed(2)}`.padEnd(8);
      const time = formatTime(e.started_at);
      lines.push(`  ${castId}  ${mode}  ${clones}  ${cost}  ${time}`);
    }
  }
  lines.push('');
  lines.push(`Remaining today: $${remaining.toFixed(2)}`);
  lines.push(`Charges: ${chargeState.current_charges}/${chargeState.charges_max}`);

  opts.reporter.info('cost.today', {
    spent: dailyState.spent_usd,
    remaining,
    entries: dailyState.entries.length,
  });

  return lines.join('\n');
}

async function renderWeek(rt: Runtime, opts: CostCommandOptions): Promise<string> {
  const log: ChargeEvent[] = await rt.ctx.charges.readLog();
  const now = Date.now();
  const oneWeekMs = 7 * 24 * 3600_000;
  const weekStart = now - oneWeekMs;

  const dailyState = await rt.ctx.dailySpend.read();

  const dayTotals = new Map<string, number>();
  for (const entry of dailyState.entries) {
    const dateKey = new Date(entry.started_at).toLocaleDateString('en-CA');
    dayTotals.set(dateKey, (dayTotals.get(dateKey) ?? 0) + entry.estimated_cost_usd);
  }

  const weekEvents = log.filter(
    (e) => e.ts >= weekStart && e.type === 'cast_start' && e.cost != null,
  );
  for (const ev of weekEvents) {
    const dateKey = new Date(ev.ts).toLocaleDateString('en-CA');
    if (!dayTotals.has(dateKey)) {
      dayTotals.set(dateKey, ev.cost ?? 0);
    }
  }

  let weekTotal = 0;
  for (const v of dayTotals.values()) weekTotal += v;

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayParts: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now - i * 24 * 3600_000);
    const key = d.toLocaleDateString('en-CA');
    const name = dayNames[d.getDay()];
    const amount = dayTotals.get(key) ?? 0;
    dayParts.push(`${name} $${amount.toFixed(2)}`);
  }

  const activeDays = dayTotals.size || 1;
  const avg = weekTotal / activeDays;

  const lines: string[] = [];
  lines.push(`This week: $${weekTotal.toFixed(2)}`);
  lines.push(`  ${dayParts.join('  ')}`);
  lines.push(`  Avg: $${avg.toFixed(2)}/day`);

  opts.reporter.info('cost.week', { total: weekTotal, avg });

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
