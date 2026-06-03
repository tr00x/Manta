import { describe, it, expect } from 'vitest';
import {
  isMantaIntent,
  stripFrontmatter,
  buildAdditionalContext,
  buildHookOutput,
  runPromptRouter,
} from '../../src/bin/manta-prompt-router.js';

describe('manta-prompt-router (UserPromptSubmit hook)', () => {
  it('detects Manta intent: word / slash command / tool / mode name', () => {
    expect(isMantaIntent('кастуй на манту')).toBe(false); // no latin "manta"
    expect(isMantaIntent('use Manta to parallelize')).toBe(true);
    expect(isMantaIntent('run /manta:cast now')).toBe(true);
    expect(isMantaIntent('call manta_status')).toBe(true);
    expect(isMantaIntent('do a recon-swarm over the repo')).toBe(true);
    expect(isMantaIntent('forking-realities for the auth design')).toBe(true);
  });

  it('does NOT trigger on unrelated prompts (no false positives)', () => {
    expect(isMantaIntent('fix the css padding')).toBe(false);
    expect(isMantaIntent('cast the value to a string')).toBe(false); // bare "cast"
    expect(isMantaIntent('clone this repo')).toBe(false); // bare "clone"
    expect(isMantaIntent('')).toBe(false);
  });

  it('strips YAML frontmatter from a SKILL.md body', () => {
    const md = '---\nname: x\ndescription: y\n---\n# Heading\nbody';
    expect(stripFrontmatter(md)).toBe('# Heading\nbody');
    expect(stripFrontmatter('# No frontmatter\nbody')).toBe('# No frontmatter\nbody');
  });

  it('additionalContext announces Manta + carries the skill body', () => {
    const ctx = buildAdditionalContext('# manta-orchestrate\nSTEP 0 router');
    expect(ctx).toMatch(/This prompt involves Manta/);
    expect(ctx).toMatch(/manta-orchestrate/);
    expect(ctx).toMatch(/STEP 0 router/);
  });

  it('hook output uses the UserPromptSubmit event shape', () => {
    const out = buildHookOutput('ctx');
    expect(out.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(out.hookSpecificOutput.additionalContext).toBe('ctx');
  });

  it('runPromptRouter injects on Manta intent, stays silent otherwise', () => {
    const reads = (p: string) => () => JSON.stringify({ prompt: p });
    let out = '';
    const write = (s: string) => {
      out += s;
    };
    // Non-Manta → nothing written.
    runPromptRouter('/nonexistent', reads('fix the css'), write);
    expect(out).toBe('');
    // Manta intent but skill unreadable (bad scriptDir) → still nothing (never throws).
    out = '';
    runPromptRouter('/nonexistent/dir', reads('use manta'), write);
    expect(out).toBe('');
  });

  it('never throws on malformed stdin', () => {
    expect(() => runPromptRouter('/x', () => 'not json', () => {})).not.toThrow();
  });
});
