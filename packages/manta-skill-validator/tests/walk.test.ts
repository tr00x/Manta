import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { walkSkillsAndCommands, validateAll } from '../src/walk.js';

describe('walkSkillsAndCommands', () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-walk-')); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('returns empty arrays when nothing exists', async () => {
    const r = await walkSkillsAndCommands(root);
    expect(r.skills).toEqual([]);
    expect(r.commands).toEqual([]);
  });

  it('discovers skills/<name>/SKILL.md', async () => {
    await fs.mkdir(path.join(root, 'skills', 'my-skill'), { recursive: true });
    await fs.writeFile(path.join(root, 'skills', 'my-skill', 'SKILL.md'), '# x', 'utf8');
    const r = await walkSkillsAndCommands(root);
    expect(r.skills.map((s) => s.name)).toEqual(['my-skill']);
  });

  it('discovers commands/<name>.md', async () => {
    await fs.mkdir(path.join(root, 'commands'), { recursive: true });
    await fs.writeFile(path.join(root, 'commands', 'cast.md'), '# x', 'utf8');
    const r = await walkSkillsAndCommands(root);
    expect(r.commands.map((c) => c.name)).toEqual(['cast']);
  });

  it('rejects unsafe directory names with unsafe_path issue', async () => {
    await fs.mkdir(path.join(root, 'skills', 'WEIRD-UPPER'), { recursive: true });
    await fs.writeFile(path.join(root, 'skills', 'WEIRD-UPPER', 'SKILL.md'), '# x', 'utf8');
    const r = await walkSkillsAndCommands(root);
    expect(r.skills).toEqual([]);
    expect(r.warnings.some((w) => w.code === 'unsafe_path')).toBe(true);
  });

  it('silently skips dotfile entries under skills/ and commands/ without warnings', async () => {
    // Simulate macOS Finder pollution + a generic dotdir.
    await fs.mkdir(path.join(root, 'skills'), { recursive: true });
    await fs.writeFile(path.join(root, 'skills', '.DS_Store'), 'binary-junk', 'utf8');
    await fs.mkdir(path.join(root, 'skills', '.hidden-dir'), { recursive: true });
    await fs.writeFile(path.join(root, 'skills', '.hidden-dir', 'SKILL.md'), '# x', 'utf8');
    await fs.mkdir(path.join(root, 'commands'), { recursive: true });
    await fs.writeFile(path.join(root, 'commands', '.DS_Store'), 'binary-junk', 'utf8');
    await fs.writeFile(path.join(root, 'commands', '.hidden.md'), '# x', 'utf8');

    const r = await walkSkillsAndCommands(root);

    expect(r.skills.map((s) => s.name)).not.toContain('.DS_Store');
    expect(r.skills.map((s) => s.name)).not.toContain('.hidden-dir');
    expect(r.commands.map((c) => c.name)).not.toContain('.DS_Store');
    expect(r.commands.map((c) => c.name)).not.toContain('.hidden');
    // No warnings should mention any of these dotfile entries.
    const joined = r.warnings.map((w) => w.message).join('\n');
    expect(joined).not.toMatch(/\.DS_Store/);
    expect(joined).not.toMatch(/\.hidden/);
    expect(r.warnings).toEqual([]);
  });
});

describe('validateAll', () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-walk-va-')); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('runs walk + validateSkill/Command and aggregates reports', async () => {
    await fs.mkdir(path.join(root, 'skills', 'good'), { recursive: true });
    await fs.writeFile(path.join(root, 'skills', 'good', 'SKILL.md'), [
      '---', 'name: good', 'description: this is a description ten or more chars', 'audience: clone', 'version: 0.0.1', '---',
      '## Purpose', 'p', '## Allowed', 'a', '## Forbidden', 'f', '## Examples', 'e',
    ].join('\n'), 'utf8');
    await fs.mkdir(path.join(root, 'skills', 'bad'), { recursive: true });
    await fs.writeFile(path.join(root, 'skills', 'bad', 'SKILL.md'), 'no frontmatter here', 'utf8');
    const result = await validateAll(root);
    const okSkills = result.reports.filter((r) => r.ok);
    expect(okSkills).toHaveLength(1);
    expect(result.allOk).toBe(false);
    expect(result.errorCount).toBeGreaterThan(0);
  });
});
