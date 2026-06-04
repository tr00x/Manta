import { describe, it, expect } from 'vitest';
import {
  isCastAction,
  decide,
  buildDeny,
  sentinelPath as gateSentinel,
} from '../../src/bin/manta-skill-gate.js';
import {
  isMantaSkillLoad,
  sentinelPath as markSentinel,
} from '../../src/bin/manta-skill-mark.js';

describe('manta-skill-gate (PreToolUse cast gate)', () => {
  it('recognises the cast action: manta_cast MCP tool + Bash `manta … cast`', () => {
    expect(isCastAction({ tool_name: 'mcp__manta-bus__manta_cast' })).toBe(true);
    expect(isCastAction({ tool_name: 'Bash', tool_input: { command: 'node x/manta.cjs cast recon-swarm' } })).toBe(true);
    expect(isCastAction({ tool_name: 'Bash', tool_input: { command: 'manta cast bug-hunt --task y' } })).toBe(true);
  });

  it('ignores non-cast tools and unrelated Bash', () => {
    expect(isCastAction({ tool_name: 'Bash', tool_input: { command: 'ls -la' } })).toBe(false);
    expect(isCastAction({ tool_name: 'Bash', tool_input: { command: 'manta status' } })).toBe(false);
    expect(isCastAction({ tool_name: 'Read' })).toBe(false);
    expect(isCastAction({ tool_name: 'mcp__manta-bus__manta_status' })).toBe(false);
  });

  it('does NOT false-fire on read commands that merely mention manta + cast paths', () => {
    // Regression: the old `\bmanta\b[^\n]*\bcast\b` blocked these read-only cmds.
    expect(isCastAction({ tool_name: 'Bash', tool_input: { command: 'grep -n foo packages/manta-cli/src/commands/cast.ts' } })).toBe(false);
    expect(isCastAction({ tool_name: 'Bash', tool_input: { command: 'cat docs/manta-bugs.md | grep cast' } })).toBe(false);
    expect(isCastAction({ tool_name: 'Bash', tool_input: { command: 'ls .manta/state/casts/' } })).toBe(false);
    expect(isCastAction({ tool_name: 'Bash', tool_input: { command: 'git log --oneline manta-cli | grep cast' } })).toBe(false);
  });

  it('DENIES a cast when the skill sentinel is absent (and injects the skill)', () => {
    const out = decide(
      { tool_name: 'mcp__manta-bus__manta_cast', session_id: 's1' },
      '/nonexistent', // skill body unreadable → still denies, just no injected body
      () => false,
    );
    expect(out?.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out?.hookSpecificOutput.permissionDecisionReason).toMatch(/manta-cast-decide|manta-orchestrate/);
  });

  it('ALLOWS (null) a cast once the sentinel exists', () => {
    const out = decide({ tool_name: 'mcp__manta-bus__manta_cast', session_id: 's1' }, '/x', () => true);
    expect(out).toBeNull();
  });

  it('has NO opinion (null) on non-cast tools regardless of sentinel', () => {
    expect(decide({ tool_name: 'Read' }, '/x', () => false)).toBeNull();
  });

  it('buildDeny carries the orchestrate body when provided', () => {
    expect(buildDeny('SKILL BODY').hookSpecificOutput.additionalContext).toMatch(/SKILL BODY/);
    expect(buildDeny(null).hookSpecificOutput.additionalContext).toBeUndefined();
  });
});

describe('manta-skill-mark (PostToolUse skill marker)', () => {
  it('fires only for Skill-tool loads of a manta-* skill', () => {
    expect(isMantaSkillLoad({ tool_name: 'Skill', tool_input: { skill: 'manta-orchestrate' } })).toBe(true);
    expect(isMantaSkillLoad({ tool_name: 'Skill', tool_input: { skill: 'manta:manta-cast-decide' } })).toBe(true);
    expect(isMantaSkillLoad({ tool_name: 'Skill', tool_input: { skill: 'some-other-skill' } })).toBe(false);
    expect(isMantaSkillLoad({ tool_name: 'Bash', tool_input: { skill: 'manta-orchestrate' } })).toBe(false);
  });

  it('gate and marker agree on the sentinel path for a session', () => {
    expect(gateSentinel('abc', '/tmp')).toBe(markSentinel('abc', '/tmp'));
  });
});
