/**
 * Shared absolute-path detector for the markdown sanitizers (post-mortem, ZK
 * note). Conservative by design: matches well-known filesystem roots plus the
 * caller's `repoRoot` prefix, so ordinary slashes in prose or embedded JSON
 * are not flagged. Returns the deduped set of matched path substrings; callers
 * decide the warning rule id and whether to redact.
 */

const STRAY_PATH_RE =
  /(?:~|\/(?:Users|home|root|var|tmp|opt|etc|private|mnt|srv))(?:\/[^\s`'")]+)+/g;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function findAbsolutePaths(text: string, repoRoot: string): string[] {
  const seen = new Set<string>();
  const repoRootRe = new RegExp(`${escapeRegExp(repoRoot)}(?:\\/[^\\s\`'")]+)*`, 'g');
  for (const re of [STRAY_PATH_RE, repoRootRe]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      seen.add(m[0]);
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return [...seen];
}
