import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

const BIN = path.resolve(__dirname, '..', 'dist', 'bin', 'server.cjs');

interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runBin(env: NodeJS.ProcessEnv, killAfterMs?: number): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
    if (killAfterMs !== undefined) {
      setTimeout(() => {
        // Closing stdin yields a clean EOF for stdio transport which the
        // server treats as "session ended"; this is the normal Claude Code
        // shutdown path. We don't need a SIGTERM/SIGINT race here.
        child.stdin?.end();
      }, killAfterMs);
    }
  });
}

describe('bin/server.cjs — startup config validation', () => {
  it('exits with code 2 when MANTA_REPO_ROOT does not exist', async () => {
    const r = await runBin({
      MANTA_REPO_ROOT: '/this/path/should/not/exist/manta-bus-test-' + Date.now(),
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/MANTA_REPO_ROOT does not exist/);
  });

  it('exits with code 2 when MANTA_REPO_ROOT is a file, not a directory', async () => {
    // Use this test file itself as the bogus value — it exists and is a file.
    const filePath = __filename;
    const r = await runBin({ MANTA_REPO_ROOT: filePath });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/MANTA_REPO_ROOT is not a directory/);
  });

  it('starts cleanly with a valid MANTA_REPO_ROOT and exits when stdin closes', async () => {
    // Pass a valid directory (the package root); kill via stdin close after
    // a short delay so the test can't hang.
    const repoRoot = path.resolve(__dirname, '..');
    const r = await runBin({ MANTA_REPO_ROOT: repoRoot }, 250);
    // stdio transport closes on EOF -> process exits 0.
    expect(r.code).toBe(0);
    // No config error in stderr; we don't assert empty stderr because the
    // signal handler isn't engaged on EOF.
    expect(r.stderr).not.toMatch(/MANTA_REPO_ROOT/);
  }, 10_000);
});
