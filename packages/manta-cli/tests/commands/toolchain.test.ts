import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectToolchain } from '../../src/commands/toolchain.js';

// Bug #M9: the merge-review gate must detect the worktree's project type and
// pick the right test command, instead of hardcoding pnpm (which DQ'd every
// non-JS candidate). Each case writes the marker file(s) into a temp dir and
// asserts the detected toolchain.
describe('detectToolchain (bug #M9)', () => {
  const dirs: string[] = [];
  function tmp(files: Record<string, string>): string {
    const d = mkdtempSync(join(tmpdir(), 'manta-tc-'));
    dirs.push(d);
    for (const [name, body] of Object.entries(files)) writeFileSync(join(d, name), body);
    return d;
  }
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('detects a pnpm workspace (Manta\'s own shape) and keeps the canonical gate', () => {
    const tc = detectToolchain(tmp({ 'pnpm-lock.yaml': '', 'package.json': '{}' }));
    expect(tc.kind).toBe('pnpm');
    expect(tc.test).toEqual(['pnpm', 'test']);
    expect(tc.isTypeScript).toBe(true);
  });

  it('detects a Python project → pytest, not TypeScript', () => {
    const tc = detectToolchain(tmp({ 'pyproject.toml': '[project]\nname="x"\n' }));
    expect(tc.kind).toBe('python');
    expect(tc.test).toEqual(['python', '-m', 'pytest', '-q']);
    expect(tc.isTypeScript).toBe(false);
  });

  it('detects a Rust project → cargo test', () => {
    const tc = detectToolchain(tmp({ 'Cargo.toml': '[package]\nname="x"\n' }));
    expect(tc.kind).toBe('cargo');
    expect(tc.test).toEqual(['cargo', 'test']);
    expect(tc.isTypeScript).toBe(false);
  });

  it('detects a Go project → go test', () => {
    const tc = detectToolchain(tmp({ 'go.mod': 'module x\n' }));
    expect(tc.kind).toBe('go');
    expect(tc.test).toEqual(['go', 'test', './...']);
  });

  it('npm project with a test script → npm test', () => {
    const tc = detectToolchain(tmp({ 'package.json': JSON.stringify({ scripts: { test: 'jest' } }) }));
    expect(tc.kind).toBe('npm');
    expect(tc.test).toEqual(['npm', 'test']);
  });

  it('npm project with NO test script → test gate skipped (null), not failed', () => {
    const tc = detectToolchain(tmp({ 'package.json': JSON.stringify({ name: 'x' }) }));
    expect(tc.kind).toBe('npm');
    expect(tc.test).toBeNull();
  });

  it('unrecognised project → no gate (test null), so the candidate is not DQ\'d', () => {
    const tc = detectToolchain(tmp({ 'README.md': '# hi' }));
    expect(tc.kind).toBe('unknown');
    expect(tc.test).toBeNull();
    expect(tc.install).toBeNull();
    expect(tc.isTypeScript).toBe(false);
  });
});
