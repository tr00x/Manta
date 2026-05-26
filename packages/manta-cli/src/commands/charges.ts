import type { Runtime } from '../runtime.js';
import type { Reporter } from '../output/reporter.js';
import type { CommandResult } from './status.js';
import { MODE_CHARGE_COST, type ChargeState, type Mode } from '@manta/bus';

export interface ChargesCommandOptions {
  reporter: Reporter;
}

function stateLabel(s: ChargeState): string {
  if (s.cooldown_until != null && Date.now() < s.cooldown_until) return 'COOLDOWN';
  if (s.current_charges < 0) return 'OVERDRAFT';
  return 'nominal';
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '0 min';
  const totalMin = Math.ceil(ms / 60_000);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export async function runChargesCommand(
  rt: Runtime,
  opts: ChargesCommandOptions,
): Promise<CommandResult> {
  const state = await rt.ctx.charges.read();
  const now = Date.now();
  const label = stateLabel(state);

  const lines: string[] = [];
  lines.push(`Charges: ${state.current_charges} / ${state.charges_max}`);
  lines.push(`State: ${label}`);

  if (label === 'COOLDOWN' && state.cooldown_until != null) {
    const remaining = state.cooldown_until - now;
    lines.push(`  Cooldown expires in ${formatDuration(remaining)}`);
    lines.push('  Use "manta refresh" to clear.');
  }

  if (label === 'OVERDRAFT') {
    lines.push('  Next failure triggers 24h cooldown.');
    lines.push('  Only cost-1 modes available.');
  }

  if (state.last_cast_ended_at > 0) {
    const agoMs = now - state.last_cast_ended_at;
    lines.push(`Last cast: ${formatDuration(agoMs)} ago`);
  }

  const idleRecoveryMs = 30 * 60_000;
  if (state.current_charges < state.charges_max) {
    const baseline = Math.max(state.last_idle_recovery_at, state.last_cast_ended_at);
    const elapsed = now - baseline;
    const nextIn = idleRecoveryMs - (elapsed % idleRecoveryMs);
    lines.push(`Idle recovery: next +1 in ${formatDuration(nextIn)}`);
  }

  lines.push('');
  lines.push('Mode availability:');

  const modes = Object.entries(MODE_CHARGE_COST) as [Mode, number][];
  for (const [mode, cost] of modes) {
    const available =
      label !== 'COOLDOWN' &&
      state.current_charges >= cost &&
      !(state.current_charges < 0 && cost > 1);
    const indicator = available ? '✓' : '✗';
    const reason =
      !available && label !== 'COOLDOWN'
        ? ` (need ${cost}, have ${state.current_charges})`
        : '';
    lines.push(`  ${mode} (${cost})`.padEnd(32) + `${indicator}${reason}`);
  }

  opts.reporter.info('charges', {
    current: state.current_charges,
    max: state.charges_max,
    state: label,
  });

  return { exitCode: 0, stdout: lines.join('\n') };
}
