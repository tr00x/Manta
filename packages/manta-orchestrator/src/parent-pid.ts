export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 is the canonical "is this PID alive?" probe on POSIX.
    // On Windows this throws EPERM for live processes; we treat any throw
    // as "dead" except EPERM, which means the process exists but we can't
    // signal it (still alive from an orchestrator's perspective).
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    return false;
  }
}

export interface PidProbe {
  alive(pid: number): boolean;
}

export interface MakeProbeOptions {
  alive?: (pid: number) => boolean;
}

export function makeProbe(opts: MakeProbeOptions = {}): PidProbe {
  return {
    alive: opts.alive ?? isProcessAlive,
  };
}
