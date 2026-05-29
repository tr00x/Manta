import type { SanitizationWarning } from './types.js';
import { scanForSecrets } from './secret-scanner.js';
import { ShareSanitizationError } from './errors.js';

// Header-line prefixes emitted by renderMarkdown
// (packages/manta-orchestrator/src/post-mortem.ts:102-106). Pinned here so a
// renderer change that moves these lines surfaces as a failing fixture test.
const P_WORKTREE = '- Worktree: ';
const P_PARENT_PID = '- Parent PID: ';
const P_REGISTERED = '- Registered at (epoch ms): ';
const P_HEARTBEAT = '- Last heartbeat at (epoch ms): ';
const P_DIED = '- Died at (epoch ms): ';

// Well-known absolute-path roots + `~` for the defense-in-depth stray-path
// scan. Deliberately conservative (named roots only) so ordinary markdown
// containing slashes (e.g. JSON in the event timeline) is not flagged.
const STRAY_PATH_RE =
  /(?:~|\/(?:Users|home|root|var|tmp|opt|etc|private|mnt|srv))(?:\/[^\s`'")]+)+/g;

function parseEpoch(v: string): number | null {
  return /^\d+$/.test(v.trim()) ? Number(v.trim()) : null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Sanitize a rendered post-mortem markdown file for bundling (Phase 7b Task 1.5).
 *
 * Operates on the on-disk markdown (share reads the file, not the live
 * `BusEvent[]`). The event timeline + metadata blocks are ALREADY leak-free at
 * render time (renderEventPayload allowlist, bug #29/#46; redactPostMortemMetadata)
 * so they are left intact. This pass redacts the post-mortem HEADER:
 *  - Worktree value → `<worktree>` (+ warning)
 *  - Parent PID line → dropped
 *  - epoch-ms timestamps → `+<delta>ms` offsets from the registered anchor
 * then runs a defense-in-depth full-text secret scan (FATAL on match) and an
 * absolute-path scan (WARN, masked) over what remains.
 */
export function sanitizePostMortemMarkdown(
  markdown: string,
  opts: { repoRoot: string },
): { sanitized: string; warnings: SanitizationWarning[] } {
  const warnings: SanitizationWarning[] = [];
  const out: string[] = [];
  let registeredAt: number | null = null;

  for (const line of markdown.split('\n')) {
    if (line.startsWith(P_WORKTREE)) {
      out.push(`${P_WORKTREE}<worktree>`);
      warnings.push({
        rule: 'postMortem.worktree',
        source: 'post-mortem header: Worktree',
        message: 'redacted an absolute worktree path to <worktree>',
        severity: 'warning',
      });
      continue;
    }
    if (line.startsWith(P_PARENT_PID)) {
      // Drop the host PID line entirely.
      continue;
    }
    if (line.startsWith(P_REGISTERED)) {
      registeredAt = parseEpoch(line.slice(P_REGISTERED.length));
      out.push(`${P_REGISTERED}+0ms`);
      continue;
    }
    if (line.startsWith(P_HEARTBEAT)) {
      const v = parseEpoch(line.slice(P_HEARTBEAT.length));
      const delta = v !== null && registeredAt !== null ? v - registeredAt : 0;
      out.push(`${P_HEARTBEAT}+${delta}ms`);
      continue;
    }
    if (line.startsWith(P_DIED)) {
      const raw = line.slice(P_DIED.length).trim();
      if (raw === 'unknown') {
        out.push(`${P_DIED}unknown`);
      } else {
        const v = parseEpoch(raw);
        const delta = v !== null && registeredAt !== null ? v - registeredAt : 0;
        out.push(`${P_DIED}+${delta}ms`);
      }
      continue;
    }
    out.push(line);
  }

  const sanitized = out.join('\n');

  // Defense-in-depth: a secret anywhere in the body is a HARD BLOCK.
  const findings = scanForSecrets(sanitized);
  if (findings.length > 0) {
    throw new ShareSanitizationError('secret_in_post_mortem', { findings });
  }

  // Stray absolute paths that survived header redaction → warn (masked).
  // Two matchers: well-known fs roots, plus the caller's repoRoot prefix
  // (which the named-root list would miss for a repo under an arbitrary path).
  const seen = new Set<string>();
  const repoRootRe = new RegExp(`${escapeRegExp(opts.repoRoot)}(?:\\/[^\\s\`'")]+)*`, 'g');
  for (const re of [STRAY_PATH_RE, repoRootRe]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sanitized)) !== null) {
      if (seen.has(m[0])) continue;
      seen.add(m[0]);
      warnings.push({
        rule: 'postMortem.strayPath',
        source: 'post-mortem body',
        message: 'found a stray absolute path outside a known header line',
        severity: 'warning',
        maskedMatch: `${m[0].slice(0, 4)}…`,
      });
    }
  }

  return { sanitized, warnings };
}
