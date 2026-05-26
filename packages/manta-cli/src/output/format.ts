export function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
}

export function formatRelativeTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s ago`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m ${totalSec % 60}s ago`;
  const hours = Math.floor(totalMin / 60);
  return `${hours}h ${totalMin % 60}m ago`;
}

export function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  if (maxLen < 4) return '...'.slice(0, maxLen);
  return s.slice(0, maxLen - 3) + '...';
}

export function formatOffsetSeconds(baseTs: number, eventTs: number): string {
  const diffMs = Math.max(0, eventTs - baseTs);
  const totalSec = diffMs / 1000;
  if (totalSec < 60) return `+${totalSec.toFixed(1)}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec - min * 60;
  return `+${min}m ${sec.toFixed(1)}s`;
}
