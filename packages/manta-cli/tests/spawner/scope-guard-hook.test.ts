import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import {
  checkScopeGuard,
  buildScopeGuardHookScript,
} from '../../src/spawner/scope-guard-hook.js';

const WORKTREE = '/repo/worktree';
const ALLOWED = ['packages/manta-cli/src/spawner', 'packages/manta-cli/tests/spawner'];
const FORBIDDEN = ['.manta/state', 'secrets/'];

function write(tool: string, file_path: string) {
  return checkScopeGuard({
    tool,
    input: { file_path },
    worktree: WORKTREE,
    allowedPaths: ALLOWED,
    forbiddenPaths: FORBIDDEN,
  });
}

function bash(command: string, allowed: readonly string[] = ALLOWED) {
  return checkScopeGuard({
    tool: 'Bash',
    input: { command },
    worktree: WORKTREE,
    allowedPaths: allowed,
    forbiddenPaths: FORBIDDEN,
  });
}

describe('checkScopeGuard — file writes', () => {
  it('allows a write inside allowedPaths', () => {
    const r = write('Write', `${WORKTREE}/packages/manta-cli/src/spawner/new.ts`);
    expect(r.blocked).toBe(false);
  });

  it('allows an Edit inside a nested allowedPath dir', () => {
    const r = write('Edit', `${WORKTREE}/packages/manta-cli/tests/spawner/deep/x.test.ts`);
    expect(r.blocked).toBe(false);
  });

  it('blocks a write outside allowedPaths but inside the worktree', () => {
    const r = write('Write', `${WORKTREE}/packages/manta-bus/src/registry.ts`);
    expect(r.blocked).toBe(true);
    expect(r.reason).toMatch(/outside allowedPaths/);
  });

  it('blocks a write to a forbidden path even if otherwise in scope', () => {
    const r = checkScopeGuard({
      tool: 'Write',
      input: { file_path: `${WORKTREE}/.manta/state/registry.json` },
      worktree: WORKTREE,
      allowedPaths: ['.'],
      forbiddenPaths: FORBIDDEN,
    });
    expect(r.blocked).toBe(true);
    expect(r.reason).toMatch(/forbidden path/);
  });

  it('blocks a write entirely outside the worktree (parent repo)', () => {
    const r = write('Write', '/repo/packages/manta-cli/src/spawner/x.ts');
    expect(r.blocked).toBe(true);
    expect(r.reason).toMatch(/outside the clone worktree/);
  });

  it('blocks a `..`-escaping relative write', () => {
    const r = write('Write', '../../../etc/passwd');
    expect(r.blocked).toBe(true);
    expect(r.reason).toMatch(/outside the clone worktree/);
  });

  it('allows last-gasp-report.md at the worktree root (graceful-death deliverable)', () => {
    const r = write('Write', `${WORKTREE}/last-gasp-report.md`);
    expect(r.blocked).toBe(false);
  });

  it('still blocks last-gasp-report.md if placed outside the worktree root', () => {
    const r = write('Write', `${WORKTREE}/packages/last-gasp-report.md`);
    expect(r.blocked).toBe(true);
  });

  it('allows the whole tree when allowedPaths is `.` (minus forbidden)', () => {
    const r = checkScopeGuard({
      tool: 'Write',
      input: { file_path: `${WORKTREE}/anywhere/file.ts` },
      worktree: WORKTREE,
      allowedPaths: ['.'],
      forbiddenPaths: FORBIDDEN,
    });
    expect(r.blocked).toBe(false);
  });

  it('scopes NotebookEdit via notebook_path', () => {
    const inScope = checkScopeGuard({
      tool: 'NotebookEdit',
      input: { notebook_path: `${WORKTREE}/packages/manta-cli/src/spawner/x.ipynb` },
      worktree: WORKTREE,
      allowedPaths: ALLOWED,
      forbiddenPaths: FORBIDDEN,
    });
    const outScope = checkScopeGuard({
      tool: 'NotebookEdit',
      input: { notebook_path: `${WORKTREE}/elsewhere/x.ipynb` },
      worktree: WORKTREE,
      allowedPaths: ALLOWED,
      forbiddenPaths: FORBIDDEN,
    });
    expect(inScope.blocked).toBe(false);
    expect(outScope.blocked).toBe(true);
  });

  it('never blocks read-only tools (Read/Grep) regardless of path', () => {
    expect(
      checkScopeGuard({
        tool: 'Read',
        input: { file_path: '/etc/passwd' },
        worktree: WORKTREE,
        allowedPaths: ALLOWED,
        forbiddenPaths: FORBIDDEN,
      }).blocked,
    ).toBe(false);
  });
});

describe('checkScopeGuard — dangerous Bash', () => {
  it('blocks plain `git push`', () => {
    const r = bash('git push origin HEAD');
    expect(r.blocked).toBe(true);
    expect(r.reason).toMatch(/git push is forbidden/);
  });

  it('blocks `git push` behind option clusters (git -c k=v push)', () => {
    const r = bash('git -c user.email="x@y.z" push --force');
    expect(r.blocked).toBe(true);
  });

  it('allows in-worktree `git add` and `git commit`', () => {
    expect(bash('git add packages/manta-cli/src/spawner').blocked).toBe(false);
    expect(
      bash('git -c user.email="x@y.z" -c user.name="X" commit -m "msg"').blocked,
    ).toBe(false);
  });

  it('blocks `rm -rf` targeting a path outside the worktree', () => {
    const r = bash('rm -rf /repo/packages');
    expect(r.blocked).toBe(true);
    expect(r.reason).toMatch(/outside the clone worktree/);
  });

  it('blocks `rm -rf ../sibling` escaping the worktree', () => {
    const r = bash('rm -rf ../clone-B');
    expect(r.blocked).toBe(true);
  });

  it('blocks `rm -rf /` and `rm -rf ~`', () => {
    expect(bash('rm -rf /').blocked).toBe(true);
    expect(bash('rm -rf ~').blocked).toBe(true);
  });

  it('blocks `rm -rf $HOME/x` with an unresolved variable target', () => {
    const r = bash('rm -rf $HOME/projectos');
    expect(r.blocked).toBe(true);
  });

  it('allows `rm -rf` of an in-worktree build dir', () => {
    const r = bash('rm -rf packages/manta-cli/dist', ['.']);
    expect(r.blocked).toBe(false);
  });

  it('blocks recursive rm of the worktree-own .git', () => {
    const r = bash('rm -rf .git', ['.']);
    expect(r.blocked).toBe(true);
    expect(r.reason).toMatch(/\.git/);
  });

  it('blocks recursive rm of a forbidden path (.manta/state)', () => {
    const r = bash('rm -rf .manta/state', ['.']);
    expect(r.blocked).toBe(true);
    expect(r.reason).toMatch(/forbidden path|\.git/);
  });

  it('blocks `git --git-dir=` pointing at the parent repo .git', () => {
    const r = bash('git --git-dir=/repo/.git log');
    expect(r.blocked).toBe(true);
    expect(r.reason).toMatch(/\.git directory outside the worktree/);
  });

  it('blocks redirecting into the parent repo .git', () => {
    const r = bash('echo pwned > /repo/.git/hooks/pre-commit');
    expect(r.blocked).toBe(true);
    expect(r.reason).toMatch(/\.git directory outside the worktree/);
  });

  it('blocks reading the parent repo .git (cat ../../.git/config)', () => {
    const r = bash('cat ../.git/config');
    expect(r.blocked).toBe(true);
  });

  it('allows touching the worktree-own .git pointer', () => {
    const r = bash('cat .git', ['.']);
    expect(r.blocked).toBe(false);
  });

  it('allows benign build/test commands', () => {
    expect(bash('pnpm gate').blocked).toBe(false);
    expect(bash('pnpm -r build && pnpm -r test').blocked).toBe(false);
    expect(bash('node scripts/x.js').blocked).toBe(false);
  });

  it('catches a dangerous op chained after a benign one', () => {
    const r = bash('pnpm test && rm -rf /repo/packages');
    expect(r.blocked).toBe(true);
  });
});

describe('buildScopeGuardHookScript — generated .cjs (end-to-end)', () => {
  let tmpDir: string;
  let scriptPath: string;
  let worktree: string;

  beforeEach(async () => {
    // realpath the tmp root so the macOS /tmp→/private/tmp symlink does not
    // make the worktree fence mismatch the canonicalized targets.
    tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'manta-scope-guard-')));
    worktree = path.join(tmpDir, 'worktree');
    await fs.mkdir(path.join(worktree, 'packages/manta-cli/src/spawner'), { recursive: true });
    scriptPath = path.join(tmpDir, 'scope-guard-hook.cjs');
    await fs.writeFile(
      scriptPath,
      buildScopeGuardHookScript({
        worktree,
        allowedPaths: ALLOWED,
        forbiddenPaths: FORBIDDEN,
        cloneId: 'A',
      }),
      'utf8',
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function runHook(frame: unknown | string): Promise<{ stdout: string; exitCode: number | null }> {
    const payload = typeof frame === 'string' ? frame : JSON.stringify(frame);
    return new Promise((resolve, reject) => {
      const child = spawn('node', [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout.on('data', (c: Buffer) => {
        stdout += c.toString('utf8');
      });
      child.on('error', reject);
      child.on('exit', (code) => resolve({ stdout, exitCode: code }));
      child.stdin.write(payload);
      child.stdin.end();
    });
  }

  function denied(stdout: string): { denied: boolean; reason?: string | undefined } {
    if (!stdout.trim()) return { denied: false };
    const out = JSON.parse(stdout) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    return {
      denied: out.hookSpecificOutput?.permissionDecision === 'deny',
      reason: out.hookSpecificOutput?.permissionDecisionReason,
    };
  }

  it('allows an in-scope Write (no deny emitted, exit 0)', async () => {
    const r = await runHook({
      tool_name: 'Write',
      tool_input: { file_path: `${worktree}/packages/manta-cli/src/spawner/x.ts` },
    });
    expect(r.exitCode).toBe(0);
    expect(denied(r.stdout).denied).toBe(false);
  });

  it('denies an out-of-scope Write with permissionDecision deny', async () => {
    const r = await runHook({
      tool_name: 'Write',
      tool_input: { file_path: `${worktree}/packages/manta-bus/src/x.ts` },
    });
    expect(r.exitCode).toBe(0);
    const d = denied(r.stdout);
    expect(d.denied).toBe(true);
    expect(d.reason).toMatch(/outside allowedPaths/);
    expect(d.reason).toMatch(/scope-guard/);
  });

  it('denies a forbidden-path Write', async () => {
    const r = await runHook({
      tool_name: 'Write',
      tool_input: { file_path: `${worktree}/secrets/key.pem` },
    });
    expect(denied(r.stdout).denied).toBe(true);
  });

  it('denies `git push`', async () => {
    const r = await runHook({ tool_name: 'Bash', tool_input: { command: 'git push' } });
    expect(denied(r.stdout).denied).toBe(true);
  });

  it('denies `rm -rf` outside the worktree', async () => {
    const r = await runHook({
      tool_name: 'Bash',
      tool_input: { command: `rm -rf ${tmpDir}/elsewhere` },
    });
    expect(denied(r.stdout).denied).toBe(true);
  });

  it('allows a benign Bash command', async () => {
    const r = await runHook({ tool_name: 'Bash', tool_input: { command: 'pnpm gate' } });
    expect(denied(r.stdout).denied).toBe(false);
  });

  it('allows a Read of any path (read-only tool)', async () => {
    const r = await runHook({
      tool_name: 'Read',
      tool_input: { file_path: '/etc/hosts' },
    });
    expect(denied(r.stdout).denied).toBe(false);
  });

  it('fails CLOSED on a malformed PreToolUse frame', async () => {
    const r = await runHook('{"tool_name": "Bash", "tool_input": {');
    expect(r.exitCode).toBe(0);
    const d = denied(r.stdout);
    expect(d.denied).toBe(true);
    expect(d.reason).toMatch(/could not be parsed|safety/i);
  });

  it('canonicalizes the /tmp symlink so a real-path target is still in scope', async () => {
    // Pass the target via the non-realpath'd os.tmpdir() form; canon() must
    // resolve it to match the realpath'd worktree baked into the hook.
    const symlinkish = path.join(os.tmpdir(), path.relative(await fs.realpath(os.tmpdir()), worktree), 'packages/manta-cli/src/spawner/y.ts');
    const r = await runHook({ tool_name: 'Write', tool_input: { file_path: symlinkish } });
    expect(denied(r.stdout).denied).toBe(false);
  });
});
