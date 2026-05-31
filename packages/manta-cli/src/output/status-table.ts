import type { OrchestratorStatus } from '@manta/orchestrator';

export interface StatusTableOptions {
  /** Include settled (DEAD) clones. Default false — DEAD are finished history, not "active". */
  showAll?: boolean;
}

export function renderStatusTable(
  status: OrchestratorStatus,
  opts: StatusTableOptions = {},
): string {
  const showAll = opts.showAll ?? false;
  const dead = status.clones.filter((c) => c.state === 'DEAD');
  const live = status.clones.filter((c) => c.state !== 'DEAD');
  // DEAD clones are finished casts, not current status — hide them by default so
  // they don't pile up forever in the view (#68). `--all` shows the full history.
  const visible = showAll ? status.clones : live;

  if (visible.length === 0) {
    // Nothing active. If settled clones exist, say so + how to see them.
    if (dead.length > 0) {
      return `No active clones. (${dead.length} settled clone(s) hidden — \`manta status --all\` to show.)`;
    }
    return 'No active clones.';
  }
  const lines: string[] = [];
  lines.push(
    'Clone | Mode         | State           | Heartbeat age | Locks                | Claims',
  );
  lines.push(
    '------+--------------+-----------------+---------------+----------------------+----------------------',
  );
  for (const c of visible) {
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
  // is not obvious from the table alone.
  lines.push('');
  if (live.length > 0) {
    const ids = live.map((c) => c.clone_id).join(', ');
    lines.push(
      `↑ "Clone" is the id. Stop one: \`manta kill <id>\` (e.g. \`manta kill ${live[0]!.clone_id}\`) · ` +
        `stop all: \`manta abort\` · details: \`manta inspect <id>\`  [live: ${ids}]`,
    );
    // When live clones are shown by default, note any settled ones folded away.
    if (!showAll && dead.length > 0) {
      lines.push(`(${dead.length} settled clone(s) hidden — \`manta status --all\` to show.)`);
    }
  } else {
    // showAll with only DEAD clones — they're finished casts.
    lines.push(
      'All clones settled (DEAD) — finished casts, safe to ignore. The next cast reuses these slots.',
    );
  }
  return lines.join('\n');
}

function pad(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width);
  return s + ' '.repeat(width - s.length);
}
