import type { OrchestratorStatus } from '@manta/orchestrator';

export function renderStatusTable(status: OrchestratorStatus): string {
  if (status.clones.length === 0) {
    return 'No active clones.';
  }
  const lines: string[] = [];
  lines.push(
    'Clone | Mode         | State           | Heartbeat age | Locks                | Claims',
  );
  lines.push(
    '------+--------------+-----------------+---------------+----------------------+----------------------',
  );
  for (const c of status.clones) {
    const ageMs = status.now - c.last_heartbeat_at;
    const ageStr = `${Math.max(0, Math.round(ageMs / 1000))}s`;
    const locks =
      status.locks
        .filter((l) => l.owner_clone_id === c.clone_id)
        .map((l) => l.path)
        .join(', ') || '-';
    const claims =
      status.claims
        .filter((cl) => cl.owner_clone_id === c.clone_id)
        .map((cl) => cl.item)
        .join(', ') || '-';
    const isDaemon = c.session_mode === 'daemon';
    const stateStr = isDaemon ? `${c.state} [daemon]` : c.state;
    const stateDisplay = c.tasks_completed != null && c.tasks_completed > 0
      ? `${stateStr} (${c.tasks_completed})`
      : stateStr;
    lines.push(
      `${pad(c.clone_id, 5)} | ${pad(c.mode, 12)} | ${pad(stateDisplay, 15)} | ${pad(ageStr, 13)} | ${pad(locks, 20)} | ${pad(claims, 20)}`,
    );
  }

  // Action hint — the `Clone` column IS the id you pass to kill/inspect, which
  // is not obvious from the table alone. Show live ids + the exact commands when
  // any clone is still alive; otherwise point at `recover` to clear settled ones.
  const live = status.clones.filter((c) => c.state !== 'DEAD');
  lines.push('');
  if (live.length > 0) {
    const ids = live.map((c) => c.clone_id).join(', ');
    lines.push(
      `↑ "Clone" is the id. Stop one: \`manta kill <id>\` (e.g. \`manta kill ${live[0]!.clone_id}\`) · ` +
        `stop all: \`manta abort\` · details: \`manta inspect <id>\`  [live: ${ids}]`,
    );
  } else {
    lines.push(
      'All clones settled (DEAD) — finished casts, safe to ignore. The next cast reuses these slots. ' +
        '(Full reset of Manta in this repo: `manta cleanup`.)',
    );
  }
  return lines.join('\n');
}

function pad(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width);
  return s + ' '.repeat(width - s.length);
}
