import { describe, it, expect } from 'vitest';
import { sanitizePostMortemMarkdown } from '../../src/share/sanitize-post-mortem.js';
import { ShareSanitizationError } from '../../src/share/errors.js';

const ROOT = '/Users/x/repo';

// Mirrors the EXACT output of renderMarkdown (packages/manta-orchestrator/src/
// post-mortem.ts:97-138). Hand-built (renderMarkdown is not exported) — the
// header line shapes are pinned to those source lines.
const fixture = (over: { died?: string } = {}): string =>
  [
    '# Post-mortem — clone B',
    '',
    '- Mode: forking-realities',
    `- Worktree: ${ROOT}/.manta/worktrees/clone-B`,
    '- Parent PID: 4242',
    '- Registered at (epoch ms): 1780020792392',
    '- Last heartbeat at (epoch ms): 1780020821681',
    `- Died at (epoch ms): ${over.died ?? '1780020900000'}`,
    '- Final state: DEAD',
    '- Reason: task complete',
    '- Recorded death_reason: <none>',
    '',
    '## Metadata',
    '- cast_id: cast-1',
    '- cast_mode: forking-realities',
    '',
    '## Thresholds in effect',
    '- heartbeatTimeoutMs: 90000',
    '- startupGraceMs: 60000',
    '- staleLockMs: 30000',
    '- parentPidCheckEnabled: true',
    '',
    '## Event timeline',
    '- `1780020821681` [heartbeat] {"state":"WORKING"}',
    '- `1780020830626` [contract_ack]',
    '',
  ].join('\n');

describe('sanitizePostMortemMarkdown', () => {
  it('redacts the Worktree line value to <worktree> with a warning', () => {
    const { sanitized, warnings } = sanitizePostMortemMarkdown(fixture(), { repoRoot: ROOT });
    expect(sanitized).toContain('- Worktree: <worktree>');
    expect(sanitized).not.toContain('.manta/worktrees/clone-B');
    expect(warnings.some((w) => w.rule === 'postMortem.worktree')).toBe(true);
  });

  it('drops the Parent PID line entirely', () => {
    const { sanitized } = sanitizePostMortemMarkdown(fixture(), { repoRoot: ROOT });
    expect(sanitized).not.toContain('Parent PID');
  });

  it('relativises the epoch-ms timestamp lines to offsets', () => {
    const { sanitized } = sanitizePostMortemMarkdown(fixture(), { repoRoot: ROOT });
    expect(sanitized).toContain('- Registered at (epoch ms): +0ms');
    // 1780020821681 - 1780020792392 = 29289
    expect(sanitized).toContain('- Last heartbeat at (epoch ms): +29289ms');
    // 1780020900000 - 1780020792392 = 107608
    expect(sanitized).toContain('- Died at (epoch ms): +107608ms');
  });

  it('keeps "Died at … unknown" as unknown', () => {
    const { sanitized } = sanitizePostMortemMarkdown(fixture({ died: 'unknown' }), { repoRoot: ROOT });
    expect(sanitized).toContain('- Died at (epoch ms): unknown');
  });

  it('leaves the Metadata block intact (already allowlisted at render time)', () => {
    const { sanitized } = sanitizePostMortemMarkdown(fixture(), { repoRoot: ROOT });
    expect(sanitized).toContain('## Metadata');
    expect(sanitized).toContain('- cast_id: cast-1');
    expect(sanitized).toContain('- cast_mode: forking-realities');
  });

  it('leaves the Event timeline block intact (already projected at render time)', () => {
    const { sanitized } = sanitizePostMortemMarkdown(fixture(), { repoRoot: ROOT });
    expect(sanitized).toContain('## Event timeline');
    expect(sanitized).toContain('[heartbeat] {"state":"WORKING"}');
  });

  it('throws fatal when a secret leaks into the body', () => {
    const md = fixture() + '\nNote: deploy key AKIAIOSFODNN7EXAMPLE was used\n';
    expect(() => sanitizePostMortemMarkdown(md, { repoRoot: ROOT })).toThrow(ShareSanitizationError);
    try {
      sanitizePostMortemMarkdown(md, { repoRoot: ROOT });
    } catch (e) {
      expect((e as ShareSanitizationError).code).toBe('secret_in_post_mortem');
    }
  });

  it('warns (masked) on a stray absolute path outside a known header line', () => {
    const md = fixture() + '\nSee /Users/x/secret-project/notes.md for context\n';
    const { warnings } = sanitizePostMortemMarkdown(md, { repoRoot: ROOT });
    const stray = warnings.filter((w) => w.rule === 'postMortem.strayPath');
    expect(stray.length).toBeGreaterThanOrEqual(1);
    expect(stray[0]!.maskedMatch).toBeDefined();
    expect(stray[0]!.maskedMatch).not.toContain('secret-project');
  });

  it('a clean post-mortem with no stray paths emits no strayPath warnings', () => {
    const { warnings } = sanitizePostMortemMarkdown(fixture(), { repoRoot: ROOT });
    expect(warnings.some((w) => w.rule === 'postMortem.strayPath')).toBe(false);
  });
});
