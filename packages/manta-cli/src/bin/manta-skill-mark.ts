#!/usr/bin/env node
// manta-skill-mark.ts — PostToolUse marker: record that a Manta skill was loaded
// this session, so the cast gate (manta-skill-gate) can clear.
//
// Paired with manta-skill-gate (PreToolUse). When the agent loads any `manta-*`
// skill via the Skill tool, this PostToolUse hook writes a per-session sentinel
// file. The gate checks that sentinel and allows casts once it exists — i.e.
// "read the skill, then you may act", the behaviour the user wants from other
// plugins.
//
// Hard constraints (mirror the other hook bins): node builtins only, NEVER
// THROW (a marker that crashes must not break the Skill tool), cheap.
import { pathToFileURL } from 'node:url';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface PostToolUsePayload {
  session_id?: string;
  tool_name?: string;
  tool_input?: { skill?: string; [k: string]: unknown };
}

/** Did this PostToolUse event load a Manta skill? */
export function isMantaSkillLoad(p: PostToolUsePayload): boolean {
  if ((p.tool_name ?? '') !== 'Skill') return false;
  const skill = p.tool_input?.skill ?? '';
  return /(^|:)manta-[a-z-]+$/i.test(skill) || /^manta-/i.test(skill);
}

/** Same path scheme as the gate. */
export function sentinelPath(sessionId: string, tmp: string = os.tmpdir()): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_') || 'nosession';
  return path.join(tmp, `manta-skill-loaded-${safe}`);
}

export function runSkillMark(
  readStdin: () => string = () => fs.readFileSync(0, 'utf8'),
  writeSentinel: (p: string) => void = (p) => fs.writeFileSync(p, 'loaded\n'),
): void {
  try {
    const payload = JSON.parse(readStdin()) as PostToolUsePayload;
    if (!isMantaSkillLoad(payload)) return;
    writeSentinel(sentinelPath(payload.session_id ?? ''));
  } catch {
    // Swallow: marking is best-effort; failure just means the gate may ask the
    // agent to load the skill again (annoying, never broken).
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
  runSkillMark();
}
