#!/usr/bin/env node
// manta-prompt-router.ts — the UserPromptSubmit routing hook.
//
// Why this exists (the user's ask, 2026-06-02): "when I use other plugins their
// skills get checked immediately, but Manta's orchestrator skill doesn't load."
// Skills are a SOFT prior — surfaced in the listing, loaded only if the model
// CHOOSES to (and compacted away under pressure). The SessionStart priming hook
// (manta-session-priming) injects a short contract once per session, but after
// that nothing guarantees the orchestrate playbook is in context when the user
// actually reaches for Manta mid-session.
//
// This hook closes that gap deterministically: on EVERY user prompt that
// mentions Manta (the word, a `/manta:` command, a `manta_*` tool, or a cast
// mode name), it injects the `manta-orchestrate` skill body as
// `additionalContext` — so the orchestration console is in context the moment
// the user thinks about Manta, without relying on the model to load it.
// Harness-injected, not model-decided (CLAUDE.md "no fake enforcement" rule:
// auto-loading belongs in a hook, not in skill text that asks to be loaded).
//
// Hard constraints (mirror manta-session-priming.ts):
//   - SELF-CONTAINED: node builtins only (the plugin bundle has no node_modules).
//   - NEVER THROW: any failure → print nothing, exit 0. A UserPromptSubmit hook
//     that crashes would surface an error on every prompt — far worse than
//     silently contributing no context.
//   - CHEAP: one stdin read + one file read, only when the prompt matches.
import { pathToFileURL } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** The exact event name Claude Code expects from a UserPromptSubmit hook. */
export const HOOK_EVENT_NAME = 'UserPromptSubmit';

/**
 * Does this prompt reach for Manta? Matches the word `manta`, a `/manta:`
 * slash command, a `manta_*` MCP tool, or any cast mode name. Deliberately
 * NARROW — a bare "cast" or "clone" alone does NOT trigger (too many unrelated
 * uses); the signal must be unambiguously Manta.
 */
export function isMantaIntent(prompt: string): boolean {
  if (typeof prompt !== 'string' || prompt.length === 0) return false;
  return (
    /\bmanta\b/i.test(prompt) ||
    /\/manta:/i.test(prompt) ||
    /\bmanta_[a-z]/i.test(prompt) ||
    /\b(recon-swarm|forking-realities|bug-hunt|refactor-wave|pair-programming|test-storm|documentation-chase)\b/i.test(
      prompt,
    )
  );
}

/** Strip a leading YAML frontmatter block (`---\n…\n---`) from a SKILL.md body. */
export function stripFrontmatter(md: string): string {
  const m = /^---\n[\s\S]*?\n---\n?/.exec(md);
  return m ? md.slice(m[0].length).trimStart() : md;
}

/**
 * Resolve the `manta-orchestrate` SKILL.md from this script's location. The hook
 * bin lives at `<pluginRoot>/dist/bin/manta-prompt-router.cjs`; skills live at
 * `<pluginRoot>/skills/`. Returns null if it can't be read (caller prints nothing).
 */
export function readOrchestrateSkill(scriptDir: string): string | null {
  try {
    const p = path.resolve(scriptDir, '..', '..', 'skills', 'manta-orchestrate', 'SKILL.md');
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Build the additionalContext: a one-line directive that the prompt touches
 * Manta, then the orchestrate skill body (the mode router + command recipes).
 * Other Manta skills (manta-cast-decide, the role skills) are pointed at from
 * inside the orchestrate skill, so injecting it alone is enough to anchor the
 * session.
 */
export function buildAdditionalContext(skillBody: string): string {
  return [
    'This prompt involves Manta. The orchestration console (`manta-orchestrate` skill) is injected below so it is in context now — use its mode router and command recipes; load `manta-cast-decide` before a non-trivial cast. (Auto-injected by the Manta UserPromptSubmit hook.)',
    '',
    '--- manta-orchestrate ---',
    skillBody.trim(),
  ].join('\n');
}

export interface PromptRouterHookOutput {
  readonly hookSpecificOutput: {
    readonly hookEventName: typeof HOOK_EVENT_NAME;
    readonly additionalContext: string;
  };
}

export function buildHookOutput(additionalContext: string): PromptRouterHookOutput {
  return { hookSpecificOutput: { hookEventName: HOOK_EVENT_NAME, additionalContext } };
}

/**
 * Read the UserPromptSubmit payload from stdin, and IF the prompt reaches for
 * Manta, print the orchestrate skill as additionalContext. Injectable read/write
 * for tests. Never throws — on any failure prints nothing (no context added).
 */
export function runPromptRouter(
  scriptDir: string,
  readStdin: () => string = () => fs.readFileSync(0, 'utf8'),
  write: (chunk: string) => void = (s) => process.stdout.write(s),
): void {
  try {
    const raw = readStdin();
    const prompt = (JSON.parse(raw) as { prompt?: string }).prompt ?? '';
    if (!isMantaIntent(prompt)) return; // not Manta → contribute nothing
    const skill = readOrchestrateSkill(scriptDir);
    if (skill === null) return;
    write(JSON.stringify(buildHookOutput(buildAdditionalContext(stripFrontmatter(skill)))));
  } catch {
    // Swallow: a prompt hook must never break prompt submission.
  }
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] != null && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  runPromptRouter(path.dirname(fileURLToPath_argv()));
}

/** __dirname shim that works in the bundled CJS without relying on import.meta. */
function fileURLToPath_argv(): string {
  // In the CJS bundle this file runs as dist/bin/manta-prompt-router.cjs; the
  // script path is process.argv[1]. Fall back to cwd only if that's unavailable.
  return process.argv[1] ?? process.cwd();
}
