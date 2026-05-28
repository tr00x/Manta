import type { CloneRecord, StoredContract, LockLease, WorkClaim, BusEvent } from '@manta/bus';
import { formatRelativeTime, truncate } from './format.js';

export interface InspectOutput {
  clone: CloneRecord;
  contract: StoredContract | null;
  locks: LockLease[];
  claims: WorkClaim[];
  recentEvents: BusEvent[];
  liveness: {
    heartbeatAgeMs: number;
    stale: boolean;
    thresholdMs: number;
  };
}

export function renderInspect(data: InspectOutput): string {
  const lines: string[] = [];
  const { clone, contract, locks, claims, recentEvents, liveness } = data;

  lines.push(`Clone ${clone.clone_id} — ${clone.state}`);
  lines.push('');

  // Identity
  lines.push('Identity');
  lines.push(`  mode:          ${clone.mode}`);
  lines.push(`  registered_at: ${new Date(clone.registered_at).toISOString()} (${formatRelativeTime(Date.now() - clone.registered_at)})`);
  const heartbeatLabel = liveness.stale ? 'STALE' : 'healthy';
  lines.push(`  heartbeat:     ${formatRelativeTime(liveness.heartbeatAgeMs)} [${heartbeatLabel}]`);
  lines.push(`  worktree:      ${clone.worktree}`);
  if (clone.progress) lines.push(`  progress:      ${clone.progress}`);
  if (clone.state === 'DEAD') {
    lines.push(`  death_reason:  ${clone.death_reason ?? 'unknown'}`);
    if (clone.died_at != null) {
      lines.push(`  died_at:       ${new Date(clone.died_at).toISOString()} (${formatRelativeTime(Date.now() - clone.died_at)})`);
    }
  }
  lines.push('');

  // Contract
  lines.push('Contract');
  if (contract == null) {
    lines.push('  (not yet written)');
  } else {
    const c = contract.contract;
    lines.push(`  task:          ${truncate(c.task, 120)}`);
    lines.push(`  scope:         allowed=[${c.scope.allowed_paths.join(', ')}] forbidden=[${c.scope.forbidden_paths.join(', ')}] maxFiles=${c.scope.max_files_changed}`);
    lines.push(`  deadline:      ${c.deadline_ms}ms`);
    lines.push(`  siblings:      ${c.sibling_clones.length > 0 ? c.sibling_clones.join(', ') : '(none)'}`);
    lines.push(`  ack:           ${contract.ack ? `acked at ${new Date(contract.ack.acked_at).toISOString()} — ${truncate(contract.ack.interpretation, 100)}` : '(not acked)'}`);
  }
  lines.push('');

  // Locks
  lines.push('Locks');
  if (locks.length === 0) {
    lines.push('  (none)');
  } else {
    for (const lock of locks) {
      const held = formatRelativeTime(Date.now() - lock.acquired_at);
      lines.push(`  ${lock.path}  held=${held}  heartbeat=${formatRelativeTime(Date.now() - lock.last_heartbeat_at)}`);
    }
  }
  lines.push('');

  // Claims
  lines.push('Claims');
  if (claims.length === 0) {
    lines.push('  (none)');
  } else {
    for (const claim of claims) {
      lines.push(`  ${claim.item}  claimed=${new Date(claim.claimed_at).toISOString()}  expires=${new Date(claim.expires_at).toISOString()}`);
    }
  }
  lines.push('');

  // Recent events
  lines.push('Recent events');
  if (recentEvents.length === 0) {
    lines.push('  (no events)');
  } else {
    for (const ev of recentEvents) {
      const ts = new Date(ev.ts).toLocaleTimeString();
      const payload = typeof ev.payload === 'string' ? ev.payload : JSON.stringify(ev.payload);
      lines.push(`  ${ts}  ${ev.type}  ${truncate(payload, 80)}`);
    }
  }

  return lines.join('\n');
}
