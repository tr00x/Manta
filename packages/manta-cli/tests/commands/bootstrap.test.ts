import { describe, it, expect, beforeAll } from 'vitest';
import { execa } from 'execa';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runBootstrap,
  formatBootstrapResult,
  type ClaudeMcpExec,
  type RunBootstrapResult,
} from '../../src/commands/bootstrap.js';
import type { ClaudeMcpResult } from '../../src/commands/mcp-preflight.js';

const ok = (o: Partial<ClaudeMcpResult> = {}): ClaudeMcpResult => ({
  exitCode: 0,
  stdout: '',
  stderr: '',
  ...o,
});

// An absolute path deliberately NOT under process.cwd(), mimicking the real
// bundle location inside an installed package (…/node_modules/manta/dist/bin).
const RESOLVED = path.join(path.sep, 'opt', 'pkg', 'manta', 'dist', 'bin', 'server.cjs');
const resolver = (): string => RESOLVED;

describe('runBootstrap (seam-injected — never spawns real claude)', () => {
  it('T1: registers when absent — add argv carries the resolved server path, not cwd', async () => {
    const calls: string[][] = [];
    const exec: ClaudeMcpExec = (args) => {
      calls.push(args);
      if (args[1] === 'get') {
        return Promise.resolve(ok({ exitCode: 1, stderr: 'No MCP server found' }));
      }
      return Promise.resolve(ok());
    };
    const res = await runBootstrap({ exec, serverPathResolver: resolver });
    expect(res.action).toBe('registered');
    expect(res.serverPath).toBe(RESOLVED);
    const add = calls.find((c) => c[1] === 'add');
    expect(add).toEqual(['mcp', 'add', '-s', 'user', 'manta-bus', '--', 'node', RESOLVED]);
    // DISCRIMINATOR: these three assertions turn RED if the resolver is pointed
    // at a cwd-relative path instead of the bundle sibling — see gate step 7.
    expect(path.isAbsolute(res.serverPath)).toBe(true);
    expect(res.serverPath.endsWith(path.join('dist', 'bin', 'server.cjs'))).toBe(true);
    expect(res.serverPath.startsWith(process.cwd())).toBe(false);
  });

  it('T2: idempotent no-op when already present (no add/remove issued)', async () => {
    const calls: string[][] = [];
    const exec: ClaudeMcpExec = (args) => {
      calls.push(args);
      return Promise.resolve(ok({ stdout: 'manta-bus: connected' }));
    };
    const res = await runBootstrap({ exec, serverPathResolver: resolver });
    expect(res.action).toBe('already-registered');
    expect(calls.map((c) => c[1])).toEqual(['get']);
    expect(calls.some((c) => c[1] === 'add' || c[1] === 'remove')).toBe(false);
  });

  it('T3: --force removes then re-adds (ordered)', async () => {
    const calls: string[][] = [];
    const exec: ClaudeMcpExec = (args) => {
      calls.push(args);
      if (args[1] === 'get') return Promise.resolve(ok({ stdout: 'manta-bus: connected' }));
      return Promise.resolve(ok());
    };
    const res = await runBootstrap({ exec, serverPathResolver: resolver, force: true });
    expect(res.action).toBe('registered');
    const subs = calls.map((c) => c[1]);
    expect(subs).toContain('remove');
    expect(subs.indexOf('add')).toBeGreaterThan(subs.indexOf('remove'));
  });

  it('T3b: --force surfaces register_failed when `mcp remove` exits non-zero', async () => {
    const exec: ClaudeMcpExec = (args) =>
      args[1] === 'get'
        ? Promise.resolve(ok({ stdout: 'manta-bus' }))
        : args[1] === 'remove'
          ? Promise.resolve(ok({ exitCode: 1, stderr: 'remove boom' }))
          : Promise.resolve(ok());
    await expect(
      runBootstrap({ exec, serverPathResolver: resolver, force: true }),
    ).rejects.toMatchObject({ name: 'CliError', kind: 'register_failed' });
  });

  it('register_failed when `mcp add` exits non-zero', async () => {
    const exec: ClaudeMcpExec = (args) =>
      args[1] === 'get'
        ? Promise.resolve(ok({ exitCode: 1 }))
        : Promise.resolve(ok({ exitCode: 1, stderr: 'add failed' }));
    await expect(
      runBootstrap({ exec, serverPathResolver: resolver }),
    ).rejects.toMatchObject({ name: 'CliError', kind: 'register_failed' });
  });

  it('T4: claude absent (exec throws) → spawn_failed mentioning claude/PATH', async () => {
    const exec: ClaudeMcpExec = () =>
      Promise.reject(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    const err = (await runBootstrap({ exec, serverPathResolver: resolver }).catch(
      (e: unknown) => e,
    )) as Error;
    expect(err).toMatchObject({ name: 'CliError', kind: 'spawn_failed' });
    expect(err.message).toMatch(/claude/);
    expect(err.message).toMatch(/PATH/);
  });

  it('T4b: probe timeout → spawn_failed timeout message', async () => {
    const exec: ClaudeMcpExec = () =>
      Promise.resolve(ok({ exitCode: undefined, timedOut: true, stdout: 'Checking…' }));
    await expect(
      runBootstrap({ exec, serverPathResolver: resolver }),
    ).rejects.toMatchObject({
      name: 'CliError',
      kind: 'spawn_failed',
      message: expect.stringContaining('timed out') as unknown as string,
    });
  });

  it('T7: --dry-run computes path+argv, calls NO exec, action=dry-run', async () => {
    const calls: string[][] = [];
    const exec: ClaudeMcpExec = (args) => {
      calls.push(args);
      return Promise.resolve(ok());
    };
    const res = await runBootstrap({ exec, serverPathResolver: resolver, dryRun: true });
    expect(res.action).toBe('dry-run');
    expect(calls).toEqual([]); // never touched claude
    expect(res.serverPath).toBe(RESOLVED);
    expect(res.command).toContain(RESOLVED);
  });

  it('default serverPathResolver yields an absolute path named server.cjs', async () => {
    // Exercises the un-injected default resolver (claude still injected so no
    // real spawn). In dev it anchors on the source sibling; assert only the
    // shape (absolute + basename) to stay dev/bundle agnostic.
    const res = await runBootstrap({
      exec: (args) => Promise.resolve(args[1] === 'get' ? ok({ exitCode: 1 }) : ok()),
    });
    expect(path.isAbsolute(res.serverPath)).toBe(true);
    expect(path.basename(res.serverPath)).toBe('server.cjs');
  });

  it('formatBootstrapResult renders each action distinctly', () => {
    const base = { serverPath: '/x/dist/bin/server.cjs', command: 'claude mcp add …' };
    expect(
      formatBootstrapResult({ action: 'registered', ...base } as RunBootstrapResult),
    ).toContain('Registered');
    expect(
      formatBootstrapResult({ action: 'already-registered', ...base } as RunBootstrapResult),
    ).toContain('already registered');
    expect(
      formatBootstrapResult({ action: 'dry-run', ...base } as RunBootstrapResult),
    ).toContain('Dry-run');
  });
});

// ── T5: routing regression against the REAL built bin ───────────────────────
// bin/manta.ts is excluded from coverage and auto-runs main() on import, so the
// only honest way to prove `install` routing is to run the bin a user actually
// gets: bare → bootstrap, <spec> → Library install. No cross-invocation.
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = path.resolve(pkgRoot, '..', '..');
const builtBin = path.join(pkgRoot, 'dist', 'bin', 'manta.js');

describe('`manta install` routing — built bin (T5)', () => {
  beforeAll(async () => {
    if (!fs.existsSync(builtBin)) {
      await execa('pnpm', ['run', 'build'], { cwd: pkgRoot });
    }
  }, 180_000);

  it('bare `install --dry-run --json` drives the bootstrap path (action=dry-run)', async () => {
    const { stdout, exitCode } = await execa('node', [builtBin, 'install', '--dry-run', '--json'], {
      cwd: repoRoot,
      reject: false,
    });
    expect(exitCode).toBe(0);
    const json = JSON.parse(stdout) as { action?: string; serverPath?: string; name?: string };
    expect(json.action).toBe('dry-run');
    expect(json.serverPath).toMatch(/dist[/\\]bin[/\\]server\.cjs$/);
    expect(json.name).toBeUndefined(); // not a Library-install result
  });

  it('`install <spec>` drives the Library install pipeline, NOT bootstrap', async () => {
    const { stdout, exitCode } = await execa(
      'node',
      [builtBin, 'install', 'some-package@1.0.0', '--offline', '--json'],
      { cwd: repoRoot, reject: false },
    );
    // Library install rejects an offline registry spec with an install_* code;
    // bootstrap would never emit one (nor an `action`). Proves spec ≠ bootstrap.
    expect(exitCode).not.toBe(0);
    const json = JSON.parse(stdout) as { action?: string; error?: { code?: string } };
    expect(json.action).toBeUndefined();
    expect(json.error?.code).toMatch(/^install_/);
  });
});
