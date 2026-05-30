import { describe, it, expect } from 'vitest';
import { validateSkill, validateCommand } from '../src/validate.js';

const validSkill = [
  '---',
  'name: manta-as-clone',
  'description: who I am as a clone — what I can and cannot do',
  'audience: clone',
  'version: 0.0.1',
  '---',
  '## Purpose',
  'p',
  '## Allowed',
  'a',
  '## Forbidden',
  'f',
  '## Examples',
  'e',
].join('\n');

const validCommand = [
  '---',
  'name: manta:cast',
  'description: spawn N clones for a given mode',
  'argument-hint: <mode> --task "<description>"',
  'allowed-tools: Bash',
  '---',
  'Run the Manta CLI `cast` subcommand via the bundled bin, then report the cast id.',
  '',
  '```bash',
  'node "${CLAUDE_PLUGIN_ROOT}/dist/bin/manta.cjs" cast $ARGUMENTS',
  '```',
].join('\n');

describe('validateSkill', () => {
  it('accepts a valid skill', () => {
    const r = validateSkill('skills/manta-as-clone/SKILL.md', validSkill);
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it('reports missing_frontmatter when no fence', () => {
    const r = validateSkill('skills/x/SKILL.md', '## Purpose\nbody');
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'missing_frontmatter')).toBe(true);
  });

  it('reports invalid_frontmatter when zod parse fails', () => {
    const bad = validSkill.replace('audience: clone', 'audience: martian');
    const r = validateSkill('skills/x/SKILL.md', bad);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'invalid_field' && i.field === 'audience')).toBe(true);
  });

  it('reports missing_section when required H2 absent', () => {
    const bad = validSkill.replace('## Forbidden\nf\n', '');
    const r = validateSkill('skills/x/SKILL.md', bad);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'missing_section' && i.message.includes('Forbidden'))).toBe(true);
  });

  it('reports parse_error when frontmatter YAML is malformed', () => {
    const r = validateSkill('skills/x/SKILL.md', '---\nname: [bad: yaml\n---\nbody\n');
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'parse_error')).toBe(true);
  });
});

describe('validateCommand', () => {
  it('accepts a valid command', () => {
    const r = validateCommand('commands/cast.md', validCommand);
    expect(r.ok).toBe(true);
  });

  it('rejects non-`manta:` prefix', () => {
    const bad = validCommand.replace('name: manta:cast', 'name: cast');
    const r = validateCommand('commands/cast.md', bad);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.field === 'name')).toBe(true);
  });
});
