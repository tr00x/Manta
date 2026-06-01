import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectToolchain } from '../../src/commands/toolchain.js';

// Bug #M9: the merge-review gate must detect the worktree's project type and
// pick the right command for EVERY quality axis (test, typecheck, lint) — not
// just the test step, and not just for TypeScript. Each case writes the marker
// file(s) into a temp dir and asserts the detected per-axis commands.
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

  it('pnpm workspace (Manta\'s own shape) keeps the canonical gate on every axis', () => {
    const tc = detectToolchain(tmp({ 'pnpm-lock.yaml': '', 'package.json': '{}' }));
    expect(tc.kind).toBe('pnpm');
    expect(tc.test).toEqual(['pnpm', 'test']);
    expect(tc.typecheck).toEqual(['pnpm', 'typecheck']);
    expect(tc.typecheckParser).toBe('tsc');
    expect(tc.lint?.slice(0, 3)).toEqual(['pnpm', 'exec', 'eslint']);
    expect(tc.lintParser).toBe('eslint-json');
  });

  it('Python → pytest, NO tsc/eslint (those axes are null, not failures)', () => {
    const tc = detectToolchain(tmp({ 'pyproject.toml': '[project]\nname="x"\n' }));
    expect(tc.kind).toBe('python');
    expect(tc.test).toEqual(['python', '-m', 'pytest', '-q']);
    expect(tc.typecheck).toBeNull();
    expect(tc.lint).toBeNull();
  });

  it('Rust → cargo test + cargo check as the type gate', () => {
    const tc = detectToolchain(tmp({ 'Cargo.toml': '[package]\nname="x"\n' }));
    expect(tc.kind).toBe('cargo');
    expect(tc.test).toEqual(['cargo', 'test']);
    expect(tc.typecheck).toEqual(['cargo', 'check']);
    expect(tc.typecheckParser).toBe('exit-code');
    expect(tc.lint).toBeNull(); // clippy is optional — not assumed present
  });

  it('Go → go test + go build (type) + go vet (lint)', () => {
    const tc = detectToolchain(tmp({ 'go.mod': 'module x\n' }));
    expect(tc.kind).toBe('go');
    expect(tc.test).toEqual(['go', 'test', './...']);
    expect(tc.typecheck).toEqual(['go', 'build', './...']);
    expect(tc.lint).toEqual(['go', 'vet', './...']);
    expect(tc.lintParser).toBe('exit-code');
  });

  it('npm + tsconfig → npm test + npx tsc --noEmit (not pnpm-specific)', () => {
    const tc = detectToolchain(
      tmp({ 'package.json': JSON.stringify({ scripts: { test: 'jest' } }), 'tsconfig.json': '{}' }),
    );
    expect(tc.kind).toBe('npm');
    expect(tc.test).toEqual(['npm', 'test']);
    expect(tc.typecheck).toEqual(['npx', '--no-install', 'tsc', '--noEmit']);
  });

  it('npm + tsconfig + eslint config → lint via npx eslint', () => {
    const tc = detectToolchain(
      tmp({ 'package.json': '{}', 'tsconfig.json': '{}', '.eslintrc.json': '{}' }),
    );
    expect(tc.lint?.slice(0, 3)).toEqual(['npx', '--no-install', 'eslint']);
  });

  it('npm WITHOUT tsconfig → typecheck null (not every JS project is TS)', () => {
    const tc = detectToolchain(tmp({ 'package.json': JSON.stringify({ scripts: { test: 'node t.js' } }) }));
    expect(tc.kind).toBe('npm');
    expect(tc.typecheck).toBeNull();
    expect(tc.lint).toBeNull(); // no eslint config
  });

  it('npm project with NO test script → test gate skipped (null), not failed', () => {
    const tc = detectToolchain(tmp({ 'package.json': JSON.stringify({ name: 'x' }) }));
    expect(tc.kind).toBe('npm');
    expect(tc.test).toBeNull();
  });

  it('unrecognised project → every axis null, candidate not DQ\'d', () => {
    const tc = detectToolchain(tmp({ 'README.md': '# hi' }));
    expect(tc.kind).toBe('unknown');
    expect(tc.test).toBeNull();
    expect(tc.install).toBeNull();
    expect(tc.typecheck).toBeNull();
    expect(tc.lint).toBeNull();
  });
});
