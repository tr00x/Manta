import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { isProcessAlive, makeProbe } from '../src/parent-pid';

describe('parent-pid', () => {
  it('isProcessAlive reports true for the current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('isProcessAlive reports false for a definitely-dead PID', () => {
    // spawn `node -e "process.exit(0)"`, capture its pid AFTER exit
    const result = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    expect(result.status).toBe(0);
    expect(typeof result.pid).toBe('number');
    // small wait to be safe — kernel may take a moment to free the slot, but kill(0)
    // returns ESRCH as soon as the process leaves the table.
    expect(isProcessAlive(result.pid)).toBe(false);
  });

  it('isProcessAlive returns false for non-positive PIDs', () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
  });

  it('makeProbe returns an injectable probe that wraps isProcessAlive by default', () => {
    const probe = makeProbe();
    expect(probe.alive(process.pid)).toBe(true);
  });

  it('makeProbe accepts an override for testing', () => {
    const probe = makeProbe({ alive: (pid) => pid === 42 });
    expect(probe.alive(42)).toBe(true);
    expect(probe.alive(99)).toBe(false);
  });
});
