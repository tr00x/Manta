import type { Runtime } from '../runtime.js';
import type { Reporter } from '../output/reporter.js';
import type { CommandResult } from './status.js';

export interface DaemonStatusOptions {
  reporter: Reporter;
}

export async function runDaemonStatusCommand(
  rt: Runtime,
  _opts: DaemonStatusOptions,
): Promise<CommandResult> {
  const allClones = await rt.ctx.registry.list();
  const daemonClones = allClones.filter(
    (c) => c.session_mode === 'daemon' && c.state !== 'DEAD',
  );
  if (daemonClones.length === 0) {
    return { exitCode: 0, stdout: 'No active daemon clones.' };
  }
  const lines = daemonClones.map((c) =>
    `${c.clone_id}\t${c.state}\ttasks=${c.tasks_completed ?? 0}\tidle_since=${c.idle_since ? new Date(c.idle_since).toISOString() : 'n/a'}`,
  );
  return { exitCode: 0, stdout: `Active daemon clones:\n${lines.join('\n')}` };
}

export interface DaemonStopOptions {
  reporter: Reporter;
  reason?: string | undefined;
}

export async function runDaemonStopCommand(
  rt: Runtime,
  opts: DaemonStopOptions,
): Promise<CommandResult> {
  const allClones = await rt.ctx.registry.list();
  const daemonClones = allClones.filter(
    (c) => c.session_mode === 'daemon' && c.state !== 'DEAD',
  );
  for (const c of daemonClones) {
    await rt.ctx.registry.markDead(
      c.clone_id,
      opts.reason ?? 'manual stop',
    );
    await rt.ctx.events.append({
      type: 'daemon_stop',
      clone_id: c.clone_id,
      payload: { reason: opts.reason ?? 'manual stop' },
    });
  }
  opts.reporter.info('daemon.stop', { count: daemonClones.length });
  return {
    exitCode: 0,
    stdout: `Stopped ${daemonClones.length} daemon clone(s).`,
  };
}
