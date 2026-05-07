import { execa } from 'execa';

export interface ClaudeBinStatus {
  available: boolean;
  path?: string;
  version?: string;
  reason?: string;
}

const PROBE_TIMEOUT_MS = 10_000;

/**
 * Probes whether a working `claude` binary is reachable. Used by the smoke test
 * to skip cleanly on machines where the binary isn't installed or authenticated.
 *
 * Honors the `CLAUDE_BIN` env var as an override for non-standard install paths
 * (e.g. `~/.local/bin/claude-experimental`, a Nix-store path, or a wrapper).
 */
export async function probeClaudeBin(): Promise<ClaudeBinStatus> {
  if (process.env.MANTA_E2E !== '1') {
    return { available: false, reason: 'MANTA_E2E env var is not set to 1 (smoke is opt-in)' };
  }
  const bin = process.env.CLAUDE_BIN ?? 'claude';
  try {
    const r = await execa(bin, ['--version'], { reject: false, timeout: PROBE_TIMEOUT_MS });
    if (r.exitCode !== 0) {
      const detail = (r.stderr || r.stdout || '<no output>').trim();
      return {
        available: false,
        path: bin,
        reason: `${bin} --version exited ${r.exitCode}: ${detail}`,
      };
    }
    return { available: true, path: bin, version: r.stdout.trim() };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { timedOut?: boolean };
    if (e.timedOut) {
      return {
        available: false,
        path: bin,
        reason: `${bin} --version timed out after ${PROBE_TIMEOUT_MS}ms (binary present but unresponsive)`,
      };
    }
    if (e.code === 'ENOENT') {
      return {
        available: false,
        path: bin,
        reason: `${bin} not found on PATH (set CLAUDE_BIN to override)`,
      };
    }
    return { available: false, path: bin, reason: `${bin} probe failed: ${e.message}` };
  }
}
