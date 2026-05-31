import { describe, it, expect } from 'vitest';
import { renderTopLevelError } from '../../src/bin/error-render.js';
import { CliError } from '../../src/errors.js';

describe('renderTopLevelError', () => {
  it('a thrown CliError renders a clean [manta] <message> line with no raw stack', () => {
    const err = new CliError('package @manta-library/foo is not installed', {
      kind: 'not_found',
      exitCode: 12,
    });
    const { lines, exitCode } = renderTopLevelError(err, { debug: false });

    expect(lines).toEqual(['[manta] package @manta-library/foo is not installed']);
    expect(exitCode).toBe(12);
    // No raw Node stack trace anywhere in the output.
    const blob = lines.join('\n');
    expect(blob).not.toMatch(/\bat \w/); // stack frames look like "    at fn (file:line)"
    expect(blob).not.toMatch(/error-render\.test\.ts/);
    // Clean line must NOT leak the internal kind tag by default.
    expect(blob).not.toContain('not_found');
  });

  it('shows the stack and kind tag only under MANTA_DEBUG (debug:true)', () => {
    const cause = new Error('underlying boom');
    const err = new CliError('cast failed', { kind: 'cast_failed', cause });
    const { lines } = renderTopLevelError(err, { debug: true });
    const blob = lines.join('\n');

    expect(blob).toContain('[manta] cast failed');
    expect(blob).toContain('[manta] kind: cast_failed');
    // Both the CliError's own stack and the cause's stack are surfaced.
    expect(blob).toMatch(/\bat /);
    expect(blob).toContain('underlying boom');
  });

  it('special-cases a CliError that asks "is the claude CLI on PATH"', () => {
    const err = new CliError('cannot run `claude mcp …` — is the claude CLI on PATH?', {
      kind: 'spawn_failed',
      exitCode: 1,
    });
    const { lines, exitCode } = renderTopLevelError(err, { debug: false });
    const blob = lines.join('\n');

    expect(blob).toContain('`claude` CLI was not found on your PATH');
    expect(blob).toMatch(/install Claude Code/i);
    expect(blob).not.toMatch(/\bat \w.*\(/); // no stack
    // Honours the CliError's own exit code when present.
    expect(exitCode).toBe(1);
  });

  it('special-cases a raw ENOENT spawn error for the claude binary', () => {
    const enoent = Object.assign(new Error("spawn claude ENOENT"), {
      code: 'ENOENT',
      path: 'claude',
      command: 'claude mcp get manta-bus',
    });
    const { lines, exitCode } = renderTopLevelError(enoent, { debug: false });
    const blob = lines.join('\n');

    expect(blob).toContain('`claude` CLI was not found on your PATH');
    // Non-CliError ENOENT => POSIX 127.
    expect(exitCode).toBe(127);
  });

  it('an unexpected (non-CliError) error gets a clean line + a debug hint, no stack', () => {
    const { lines, exitCode } = renderTopLevelError(new Error('totally unexpected'), {
      debug: false,
    });
    const blob = lines.join('\n');

    expect(blob).toContain('[manta] unexpected error: totally unexpected');
    expect(blob).toContain('MANTA_DEBUG=1');
    expect(blob).not.toMatch(/\bat \w.*\(/);
    expect(exitCode).toBe(99);
  });

  it('an unexpected error under debug shows its stack', () => {
    const { lines } = renderTopLevelError(new Error('boom'), { debug: true });
    const blob = lines.join('\n');
    expect(blob).toMatch(/\bat /);
    expect(blob).not.toContain('MANTA_DEBUG=1'); // hint suppressed when already debugging
  });

  it('does not infinite-loop on a cyclic cause chain', () => {
    const a = new Error('a') as Error & { cause?: unknown };
    const b = new Error('b') as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a; // cycle
    const { lines, exitCode } = renderTopLevelError(a, { debug: true });
    expect(exitCode).toBe(99);
    expect(lines.join('\n')).toContain('[manta] unexpected error: a');
  });
});
