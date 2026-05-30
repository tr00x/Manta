import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAll } from '../src/walk.js';

// tests/integration.test.ts → tests/ → manta-skill-validator/ → packages/ → repo
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('Phase 0e content integration', () => {
  it('every Phase-0 skill and command file passes the validator', async () => {
    const result = await validateAll(repoRoot);
    if (!result.allOk) {
      const detail = result.reports
        .filter((r) => r.issues.length > 0)
        .map((r) => `${r.path}\n  ${r.issues.map((i) => `[${i.severity}] ${i.code}: ${i.message}`).join('\n  ')}`)
        .join('\n');
      throw new Error(`validation failed:\n${detail}`);
    }
    expect(result.errorCount).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  it('all skills are present', async () => {
    const result = await validateAll(repoRoot);
    const skillReports = result.reports.filter((r) => r.path.startsWith('skills/'));
    const skills = skillReports.map((r) => r.path.replace(/^skills\//, '').replace(/\/SKILL\.md$/, '')).sort();
    expect(skills).toEqual(['manta-as-clone', 'manta-cast-decide', 'manta-coordinate', 'manta-daemon-idle', 'manta-doc-chase', 'manta-graceful-death', 'manta-merge-review', 'manta-orchestrate', 'manta-pair-protocol', 'manta-pair-reviewer', 'manta-pair-writer', 'manta-storm-coder', 'manta-storm-fuzzer', 'manta-storm-tester']);
  });

  it('all slash commands are present', async () => {
    const result = await validateAll(repoRoot);
    const commandReports = result.reports.filter((r) => r.path.startsWith('commands/'));
    const commands = commandReports.map((r) => r.path.replace(/^commands\//, '').replace(/\.md$/, '')).sort();
    expect(commands).toEqual(['abort', 'cast', 'cost', 'help', 'kill', 'promote', 'recover', 'status']);
  });
});
