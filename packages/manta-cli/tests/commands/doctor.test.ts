import { describe, it, expect } from 'vitest';
import type { ChargeState } from '@manta/bus';

import { runDoctorCommand, type DoctorProbes } from '../../src/commands/doctor.js';
import type { ClaudeMcpResult } from '../../src/commands/mcp-preflight.js';

const mcp = (overrides: Partial<ClaudeMcpResult>): ClaudeMcpResult => ({
  exitCode: 0,
  stdout: '',
  stderr: '',
  ...overrides,
});

const charges = (overrides: Partial<ChargeState>): ChargeState => ({
  version: 1,
  current_charges: 5,
  charges_max: 5,
  charges_min: -3,
  last_idle_recovery_at: 0,
  last_cast_ended_at: 0,
  cooldown_until: null,
  total_successes: 0,
  total_failures: 0,
  total_casts: 0,
  ...overrides,
});

/** A fully-healthy probe set; individual tests override one field. */
const healthyProbes = (overrides: Partial<DoctorProbes> = {}): Partial<DoctorProbes> => ({
  cwd: '/repo',
  nodeVersion: () => 'v20.11.0',
  claudeOnPath: () => Promise.resolve(true),
  busRunner: () => Promise.resolve(mcp({ stdout: 'manta-bus: connected\n' })),
  isGitRepo: () => Promise.resolve(true),
  readCharges: () => Promise.resolve(charges({})),
  mantaVersion: () => '0.1.0',
  ...overrides,
});

describe('runDoctorCommand', () => {
  it('all checks pass on a healthy environment, exit 0', async () => {
    const r = await runDoctorCommand({ probes: healthyProbes() });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('All 6 checks passed.');
    expect(r.stdout).not.toContain('✗');
  });

  it('always exits 0 even when checks fail (diagnostic, not a gate)', async () => {
    const r = await runDoctorCommand({
      probes: healthyProbes({
        claudeOnPath: () => Promise.resolve(false),
        isGitRepo: () => Promise.resolve(false),
        readCharges: () => Promise.resolve(null),
      }),
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('✗');
    expect(r.stdout).toContain('checks passed');
  });

  it('flags an outdated Node version with an actionable hint', async () => {
    const r = await runDoctorCommand({
      probes: healthyProbes({ nodeVersion: () => 'v18.19.0' }),
    });
    expect(r.stdout).toContain('✗ Node version');
    expect(r.stdout).toContain('Node >= 20');
  });

  it('accepts Node 20 and above', async () => {
    const r = await runDoctorCommand({
      probes: healthyProbes({ nodeVersion: () => 'v22.3.0' }),
    });
    expect(r.stdout).toMatch(/✓ Node version/);
  });

  it('flags a missing claude CLI', async () => {
    const r = await runDoctorCommand({
      probes: healthyProbes({ claudeOnPath: () => Promise.resolve(false) }),
    });
    expect(r.stdout).toContain('✗ claude CLI on PATH');
    expect(r.stdout).toContain('install Claude Code');
  });

  it('passes the bus check when registered under the plugin-namespaced name', async () => {
    const r = await runDoctorCommand({
      probes: healthyProbes({
        busRunner: (name: string) =>
          name === 'plugin:manta:manta-bus'
            ? Promise.resolve(mcp({ stdout: 'manta-bus: connected\n' }))
            : Promise.resolve(mcp({ exitCode: 1, stderr: 'No MCP server found' })),
      }),
    });
    expect(r.stdout).toContain('✓ manta-bus MCP server');
    expect(r.stdout).toContain('plugin:manta:manta-bus');
  });

  it('flags an unregistered bus with an install hint', async () => {
    const r = await runDoctorCommand({
      probes: healthyProbes({
        busRunner: () => Promise.resolve(mcp({ exitCode: 1, stderr: 'No MCP server found' })),
      }),
    });
    expect(r.stdout).toContain('✗ manta-bus MCP server');
    expect(r.stdout).toContain('manta install');
  });

  it('reports a bus probe failure when claude is not on PATH (runner rejects)', async () => {
    const r = await runDoctorCommand({
      probes: healthyProbes({
        busRunner: () => {
          const e = new Error('spawn ENOENT');
          (e as NodeJS.ErrnoException).code = 'ENOENT';
          return Promise.reject(e);
        },
      }),
    });
    expect(r.stdout).toContain('✗ manta-bus MCP server');
    expect(r.stdout).toContain('claude CLI on PATH');
  });

  it('flags a non-git cwd with a `git init` hint', async () => {
    const r = await runDoctorCommand({
      probes: healthyProbes({ isGitRepo: () => Promise.resolve(false) }),
    });
    expect(r.stdout).toContain('✗ cwd is a git repo');
    expect(r.stdout).toContain('git init');
  });

  it('surfaces an active cooldown with a refresh hint', async () => {
    const r = await runDoctorCommand({
      probes: healthyProbes({
        readCharges: () =>
          Promise.resolve(charges({ current_charges: 0, cooldown_until: Date.now() + 3_600_000 })),
      }),
    });
    expect(r.stdout).toContain('✗ Charges / cooldown');
    expect(r.stdout).toContain('COOLDOWN');
    expect(r.stdout).toContain('manta refresh');
  });

  it('surfaces an overdraft state', async () => {
    const r = await runDoctorCommand({
      probes: healthyProbes({
        readCharges: () => Promise.resolve(charges({ current_charges: -1 })),
      }),
    });
    expect(r.stdout).toContain('✗ Charges / cooldown');
    expect(r.stdout).toContain('OVERDRAFT');
  });

  it('reports nominal charges when healthy', async () => {
    const r = await runDoctorCommand({
      probes: healthyProbes({
        readCharges: () => Promise.resolve(charges({ current_charges: 4, charges_max: 5 })),
      }),
    });
    expect(r.stdout).toContain('✓ Charges / cooldown');
    expect(r.stdout).toContain('4/5');
  });

  it('handles a missing charge ledger (no cast has run yet)', async () => {
    const r = await runDoctorCommand({
      probes: healthyProbes({ readCharges: () => Promise.resolve(null) }),
    });
    expect(r.stdout).toContain('✗ Charges / cooldown');
    expect(r.stdout).toContain('no ledger');
  });

  it('reports the manta version', async () => {
    const r = await runDoctorCommand({
      probes: healthyProbes({ mantaVersion: () => '9.9.9' }),
    });
    expect(r.stdout).toContain('✓ manta version');
    expect(r.stdout).toContain('9.9.9');
  });
});
