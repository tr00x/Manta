#!/usr/bin/env node
// manta-skill-gate.ts — PreToolUse gate: REQUIRE the orchestration skill be
// loaded before a Manta cast runs.
//
// The user's ask (2026-06-02): "make it like other plugins that require reading
// the skills first before acting." The UserPromptSubmit router injects the
// orchestrate skill on a Manta-intent prompt (soft-but-always-seen), but the
// user wants a HARD gate: a cast must not proceed until the agent has actually
// loaded the Manta orchestration skill this session.
//
// Mechanism (CLAUDE.md "enforcement = PreToolUse hook, not skill text"):
//   - This PreToolUse hook matches the cast action — the `manta_cast` MCP tool
//     OR a Bash `manta … cast` invocation (covers `/manta:cast`, which shells
//     out to the binary).
//   - It looks for a per-session sentinel written by the PostToolUse-on-Skill
//     marker (manta-skill-mark) when a `manta-*` skill is loaded.
//   - Sentinel present  → allow (skill was read this session).
//     Sentinel absent   → DENY with a reason telling the agent to load
//     `manta-cast-decide` / `manta-orchestrate` first, and inject the
//     orchestrate skill so the next attempt is informed.
//
// Hard constraints (mirror the other hook bins):
//   - SELF-CONTAINED: node builtins only.
//   - NEVER THROW / FAIL-OPEN: on ANY error, allow the action (print nothing /
//     allow). A gate that crashes must never wedge the user's cast — it degrades
//     to "no gate", never to "everything blocked".
import { pathToFileURL } from 'node:url';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const HOOK_EVENT_NAME = 'PreToolUse';
/** Skills whose load satisfies the gate. */
export const REQUIRED_SKILLS = ['manta-orchestrate', 'manta-cast-decide'] as const;

export interface PreToolUsePayload {
  session_id?: string;
  tool_name?: string;
  tool_input?: { command?: string; mode?: string; [k: string]: unknown };
}

/** Is this tool call a Manta CAST (the action we gate)? */
export function isCastAction(p: PreToolUsePayload): boolean {
  const t = p.tool_name ?? '';
  if (/manta_cast$/i.test(t) || t === 'mcp__manta-bus__manta_cast') return true;
  if (t === 'Bash') {
    const cmd = p.tool_input?.command ?? '';
    // Match an actual cast INVOCATION — the `cast` subcommand IMMEDIATELY after a
    // manta binary token: `manta cast …`, `manta.cjs cast …`, `node …/manta.cjs
    // cast …`. The previous `\bmanta\b[^\n]*\bcast\b` was far too broad — it
    // false-fired on any command merely mentioning a manta path AND the word cast
    // (e.g. `grep … packages/manta-cli/src/commands/cast.ts`, `cat docs/…cast…`),
    // blocking read-only commands. Require adjacency: manta(.cjs) <space> cast.
    return /\bmanta(?:\.cjs)?\s+cast\b/i.test(cmd);
  }
  return false;
}

/** Per-session sentinel path (written by manta-skill-mark on skill load). */
export function sentinelPath(sessionId: string, tmp: string = os.tmpdir()): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_') || 'nosession';
  return path.join(tmp, `manta-skill-loaded-${safe}`);
}

/** Read the orchestrate skill body to inject in the deny reason. Null on failure. */
export function readOrchestrateSkill(scriptDir: string): string | null {
  try {
    return fs.readFileSync(
      path.resolve(scriptDir, '..', '..', 'skills', 'manta-orchestrate', 'SKILL.md'),
      'utf8',
    );
  } catch {
    return null;
  }
}

export interface GateOutput {
  hookSpecificOutput: {
    hookEventName: typeof HOOK_EVENT_NAME;
    permissionDecision: 'allow' | 'deny';
    permissionDecisionReason?: string;
    additionalContext?: string;
  };
}

export function buildDeny(skillBody: string | null): GateOutput {
  const reason =
    'Manta requires its orchestration skill before a cast. Load the `manta-cast-decide` skill (decide whether/which mode to cast) and `manta-orchestrate` skill (the cast playbook) via the Skill tool, THEN re-run the cast. This gate clears for the rest of the session once a manta-* skill is loaded.';
  const out: GateOutput = {
    hookSpecificOutput: {
      hookEventName: HOOK_EVENT_NAME,
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
  if (skillBody) out.hookSpecificOutput.additionalContext = `--- manta-orchestrate ---\n${skillBody.trim()}`;
  return out;
}

/**
 * Decide the gate for one PreToolUse payload. Returns the JSON to print, or null
 * to print nothing (allow). Reads the sentinel via an injectable predicate.
 */
export function decide(
  payload: PreToolUsePayload,
  scriptDir: string,
  sentinelExists: (sessionId: string) => boolean,
): GateOutput | null {
  if (!isCastAction(payload)) return null; // not a cast → no opinion
  const session = payload.session_id ?? '';
  if (sentinelExists(session)) return null; // skill already loaded → allow
  return buildDeny(readOrchestrateSkill(scriptDir));
}

export function runSkillGate(
  scriptDir: string,
  readStdin: () => string = () => fs.readFileSync(0, 'utf8'),
  write: (chunk: string) => void = (s) => process.stdout.write(s),
  sentinelExists: (sessionId: string) => boolean = (s) => {
    try {
      return fs.existsSync(sentinelPath(s));
    } catch {
      return false;
    }
  },
): void {
  try {
    const payload = JSON.parse(readStdin()) as PreToolUsePayload;
    const out = decide(payload, scriptDir, sentinelExists);
    if (out !== null) write(JSON.stringify(out));
  } catch {
    // FAIL-OPEN: never block a cast because the gate errored.
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
  runSkillGate(path.dirname(process.argv[1] ?? process.cwd()));
}
