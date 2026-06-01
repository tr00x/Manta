import type { BusContext, CloneRecord } from '@manta/bus';
import type { Thresholds } from './thresholds';
import type { PidProbe } from './parent-pid';

export interface DeadCloneFinding {
  clone_id: string;
  record: CloneRecord;
  reason: string;
}

export interface FindDeadCloneOptions {
  thresholds: Thresholds;
  probe: PidProbe;
}

export async function findDeadClones(
  ctx: Pick<BusContext, 'registry' | 'clock'>,
  options: FindDeadCloneOptions,
): Promise<DeadCloneFinding[]> {
  const all = await ctx.registry.list();
  const now = ctx.clock.now();
  const out: DeadCloneFinding[] = [];
  for (const r of all) {
    if (r.state === 'DEAD') continue;
    const reasons: string[] = [];

    if (r.state === 'STARTING') {
      // bug #66: measure the startup grace from the last heartbeat, not from
      // registration. The spawner emits a "booting" heartbeat at process LAUNCH
      // (clone-spawner.ts, right after runner.run), so last_heartbeat_at marks
      // when the child actually started. Measuring from registered_at penalized
      // the clone for pre-launch prep + the entire cold-start window and reaped it
      // before it could call the bus — a failure that scaled with parent
      // transcript size and killed casts late in a long session.
      const sinceLaunch = now - r.last_heartbeat_at;
      if (sinceLaunch > options.thresholds.startupGraceMs) {
        reasons.push(
          `startup grace ${sinceLaunch}ms > ${options.thresholds.startupGraceMs}ms (no first heartbeat)`,
        );
      }
      // bug #70: the spawner's booting-ticker (clone-spawner.ts) keeps
      // last_heartbeat_at fresh while a clone is alive-but-quiet during cold
      // boot, so `sinceLaunch` alone can no longer reap a process that hangs in
      // STARTING forever (the ticker would touch it indefinitely). Enforce an
      // ABSOLUTE cap on time-in-STARTING measured from registration: a clone
      // that has not begun real work within startupHardCapMs is wedged, reap it.
      const sinceRegistered = now - r.registered_at;
      if (sinceRegistered > options.thresholds.startupHardCapMs) {
        reasons.push(
          `startup hard cap ${sinceRegistered}ms > ${options.thresholds.startupHardCapMs}ms (stuck in STARTING)`,
        );
      }
    } else if (r.state === 'IDLE' || r.state === 'WAITING_FOR_TASK') {
      const sinceHeartbeat = now - r.last_heartbeat_at;
      if (sinceHeartbeat > options.thresholds.idleHeartbeatTimeoutMs) {
        reasons.push(
          `idle heartbeat ${sinceHeartbeat}ms ago > ${options.thresholds.idleHeartbeatTimeoutMs}ms`,
        );
      }
      if (r.idle_since != null) {
        const idleDuration = now - r.idle_since;
        if (idleDuration > options.thresholds.maxIdleTimeMs) {
          reasons.push(
            `idle for ${idleDuration}ms > maxIdleTimeMs ${options.thresholds.maxIdleTimeMs}ms`,
          );
        }
      }
    } else {
      const sinceHeartbeat = now - r.last_heartbeat_at;
      if (sinceHeartbeat > options.thresholds.heartbeatTimeoutMs) {
        reasons.push(
          `heartbeat ${sinceHeartbeat}ms ago > ${options.thresholds.heartbeatTimeoutMs}ms`,
        );
      }
    }

    if (r.session_mode === 'daemon') {
      const sessionAge = now - r.registered_at;
      if (sessionAge > options.thresholds.daemonMaxLifetimeMs) {
        reasons.push(
          `daemon session ${sessionAge}ms > daemonMaxLifetimeMs ${options.thresholds.daemonMaxLifetimeMs}ms`,
        );
      }
    }

    if (options.thresholds.parentPidCheckEnabled && !options.probe.alive(r.parent_pid)) {
      reasons.push(`parent pid ${r.parent_pid} not alive`);
    }
    if (reasons.length > 0) {
      out.push({ clone_id: r.clone_id, record: r, reason: reasons.join('; ') });
    }
  }
  return out;
}
