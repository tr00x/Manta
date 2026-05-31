#!/usr/bin/env node
// manta-session-priming.ts — the SessionStart priming hook.
//
// Why this exists: Manta's orchestration discipline lives in SKILLS
// (manta-cast-decide, manta-orchestrate, manta-merge-review). Skills are a SOFT
// prior — surfaced in the skill list, but the agent only loads them if it
// chooses to, and they get compacted away under context pressure
// (docs/internals/claude-code-pitfalls.md §3). A fresh user's agent therefore
// has /manta:* + the skills surfaced but NOTHING guaranteeing it loads
// manta-orchestrate before its first cast — so it can cast naively (no
// cast-decide gate, no merge ceremony, not serial-aware).
//
// A plugin SessionStart hook closes that gap: the priming text below is injected
// as `additionalContext` on EVERY session start (and re-injected after
// clear/compact, when skill context is wiped). The plugin being enabled IS the
// relevance signal — the hook only fires when Manta is installed.
//
// This PRIMES, it does not ENFORCE. Per the project's no-fake-enforcement rule
// (CLAUDE.md "Skill/priming/enforcement HARD RULES"), a hook cannot force tool
// ordering — it makes the orchestration contract always-seen and points at the
// skills that carry the detail. Soft-but-always-seen beats soft-and-maybe-loaded.
//
// Hard constraints (mirrors manta-statusline.ts):
//   - SELF-CONTAINED: node builtins only. The plugin bundle has no node_modules,
//     and a one-shot static print needs nothing more.
//   - NEVER THROW: any failure resolves to printing nothing and exiting 0. A
//     SessionStart hook that crashes is worse than one that says nothing — it
//     would surface a hook error on every session.
//   - CHEAP: no I/O, no child process, no network. Just serialize a constant.
import { pathToFileURL } from 'node:url';
import * as fs from 'node:fs';

/**
 * The orchestration contract injected into the user's main agent. Kept short
 * (~6 lines) because it is injected every session — it POINTS at the skills
 * (which carry the full detail) rather than duplicating them. Phrased as soft
 * guidance ("consider", "load … to decide"), never as a forced tool ordering.
 */
export const PRIMING = [
  'Manta is installed here (the self-cloning Claude Code pattern). Orchestration contract for THIS agent:',
  '- For a non-trivial task (>~10 min, multi-file, or parallelizable), consider casting clones instead of working solo — load the `manta-cast-decide` skill to decide whether to cast and which mode.',
  '- To drive a cast end-to-end, follow the `manta-orchestrate` skill: launch → observe with `/manta:status` (do NOT poll the bus) → for forking-realities read the merge-review FIRST, then merge the winner → `/manta:recover`.',
  '- Run casts serially-aware (one cast at a time unless you know they are isolated). `manta doctor` checks your setup; `/manta:help` lists the commands.',
  'These skills carry the detail — load the relevant one rather than guessing. This is guidance, not a hard gate.',
].join('\n');

/** The exact `hookSpecificOutput.hookEventName` Claude Code expects for this event. */
export const HOOK_EVENT_NAME = 'SessionStart';

/**
 * The JSON object Claude Code reads from a SessionStart hook's stdout. The
 * `additionalContext` string is appended to the agent's context for the session.
 * Shape verified against the live `learning-output-style` official plugin.
 */
export interface SessionStartHookOutput {
  readonly hookSpecificOutput: {
    readonly hookEventName: typeof HOOK_EVENT_NAME;
    readonly additionalContext: string;
  };
}

/** Build the hook output object. Pure — no I/O, deterministic, easy to assert. */
export function buildHookOutput(priming: string = PRIMING): SessionStartHookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: HOOK_EVENT_NAME,
      additionalContext: priming,
    },
  };
}

/** Serialize the hook output to the single line Claude Code parses from stdout. */
export function serializeHookOutput(priming: string = PRIMING): string {
  return JSON.stringify(buildHookOutput(priming));
}

/**
 * Entry point: print the priming JSON and exit 0 no matter what. A write
 * function is injectable so tests can capture output without touching stdout.
 * Never throws — on any failure it prints nothing, which Claude Code treats as
 * "this hook contributed no context", and the session proceeds normally.
 */
export function runSessionPriming(write: (chunk: string) => void = (s) => process.stdout.write(s)): void {
  try {
    write(serializeHookOutput());
  } catch {
    // Swallow: a priming hook must never break session startup.
  }
}

// Run only when executed directly (`node manta-session-priming.cjs`), never on
// import — tests import the builders without triggering a print.
const invokedDirectly = (() => {
  try {
    return process.argv[1] != null && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  runSessionPriming();
}
