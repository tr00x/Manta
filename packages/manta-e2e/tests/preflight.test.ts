import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { validateAll } from '@manta/skill-validator';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('Phase-0 pre-flight (cheap, always runs)', () => {
  it('every workspace package builds clean', { timeout: 5 * 60 * 1000 }, async () => {
    const r = await execa('pnpm', ['-r', 'build'], { cwd: repoRoot, reject: false });
    expect(r.exitCode, r.stderr || r.stdout).toBe(0);
  });

  it('skill-validator finds 14 skills and 7 commands, zero errors', async () => {
    const result = await validateAll(repoRoot);
    expect(result.errorCount).toBe(0);
    const skills = result.reports.filter((r) => r.path.startsWith('skills/'));
    const commands = result.reports.filter((r) => r.path.startsWith('commands/'));
    expect(skills).toHaveLength(14);
    expect(commands).toHaveLength(7);
  });

  it('manta CLI is built and `manta status` runs cleanly on an empty tmp repo', { timeout: 5 * 60 * 1000 }, async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-preflight-'));
    try {
      // `manta status` enforces a git repo root; init the tmp dir before invoking.
      await execa('git', ['init', '-q', '-b', 'main'], { cwd: tmpDir });
      const cli = path.join(repoRoot, 'packages/manta-cli/dist/bin/manta.cjs');
      const r = await execa('node', [cli, 'status'], { cwd: tmpDir, reject: false });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('No active clones');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
