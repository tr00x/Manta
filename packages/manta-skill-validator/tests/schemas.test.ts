import { describe, it, expect } from 'vitest';
import { SkillFrontmatterSchema, SlashCommandFrontmatterSchema, REQUIRED_SKILL_SECTIONS, REQUIRED_COMMAND_SECTIONS } from '../src/schemas.js';

describe('schemas', () => {
  it('SkillFrontmatterSchema accepts a valid record', () => {
    const r = SkillFrontmatterSchema.safeParse({
      name: 'manta-as-clone',
      description: 'For clones — who I am',
      audience: 'clone',
      version: '0.0.1',
    });
    expect(r.success).toBe(true);
  });

  it('SkillFrontmatterSchema rejects unknown audience', () => {
    expect(SkillFrontmatterSchema.safeParse({
      name: 'x', description: 'd', audience: 'martian', version: '0.0.1',
    }).success).toBe(false);
  });

  it('SkillFrontmatterSchema requires kebab-case name', () => {
    expect(SkillFrontmatterSchema.safeParse({
      name: 'NotKebab', description: 'd', audience: 'clone', version: '0.0.1',
    }).success).toBe(false);
    expect(SkillFrontmatterSchema.safeParse({
      name: 'with spaces', description: 'd', audience: 'clone', version: '0.0.1',
    }).success).toBe(false);
  });

  it('SlashCommandFrontmatterSchema enforces /manta-namespaced names', () => {
    const ok = SlashCommandFrontmatterSchema.safeParse({
      name: 'manta:cast',
      description: 'Cast clones',
      target: 'manta cli',
    });
    expect(ok.success).toBe(true);
    const bad = SlashCommandFrontmatterSchema.safeParse({
      name: 'cast', description: 'd', target: 't',
    });
    expect(bad.success).toBe(false);
  });

  it('REQUIRED_SKILL_SECTIONS lists Purpose / Allowed / Forbidden / Examples', () => {
    expect(REQUIRED_SKILL_SECTIONS).toEqual(['Purpose', 'Allowed', 'Forbidden', 'Examples']);
  });

  it('REQUIRED_COMMAND_SECTIONS lists Usage / Arguments / Behavior', () => {
    expect(REQUIRED_COMMAND_SECTIONS).toEqual(['Usage', 'Arguments', 'Behavior']);
  });
});
