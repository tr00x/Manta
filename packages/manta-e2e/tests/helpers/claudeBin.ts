import { execa } from 'execa';

export interface ClaudeBinStatus {
  available: boolean;
  path?: string;
  version?: string;
  reason?: string;
}

/**
 * Probes whether a working `claude` binary is reachable. Used by the smoke test
 * to skip cleanly on machines where the binary isn't installed or authenticated.
 */
export async function probeClaudeBin(): Promise<ClaudeBinStatus> {
  if (process.env.MANTA_E2E !== '1') {
    return { available: false, reason: 'MANTA_E2E env var is not set to 1 (smoke is opt-in)' };
  }
  try {
    const r = await execa('claude', ['--version'], { reject: false, timeout: 10_000 });
    if (r.exitCode !== 0) {
      return { available: false, reason: `claude --version exited ${r.exitCode}: ${r.stderr || r.stdout}` };
    }
    return { available: true, path: 'claude', version: r.stdout.trim() };
  } catch (err) {
    return { available: false, reason: `claude not found on PATH: ${(err as Error).message}` };
  }
}
