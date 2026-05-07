import type { OrchestratorStatus } from '@manta/orchestrator';

export function renderStatusTable(status: OrchestratorStatus): string {
  if (status.clones.length === 0) {
    return 'No active clones.';
  }
  const lines: string[] = [];
  lines.push(
    'Clone | Mode         | State        | Heartbeat age | Locks                | Claims',
  );
  lines.push(
    '------+--------------+--------------+---------------+----------------------+----------------------',
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
    lines.push(
      `${pad(c.clone_id, 5)} | ${pad(c.mode, 12)} | ${pad(c.state, 12)} | ${pad(ageStr, 13)} | ${pad(locks, 20)} | ${pad(claims, 20)}`,
    );
  }
  return lines.join('\n');
}

function pad(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width);
  return s + ' '.repeat(width - s.length);
}
