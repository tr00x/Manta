import { BusConflictError, type BusContext, type BusEvent, type LockLease, type WorkClaim } from '@manta/bus';
import type { Thresholds } from './thresholds';
import type { PidProbe } from './parent-pid';
import type { PostMortemWriter } from './post-mortem-writer';
import type { ForensicTimelineWriter } from './forensic-timeline';
import { findDeadClones, type DeadCloneFinding } from './death-detector';
import { reapLocks } from './lock-reaper';
import { reapClaims } from './claim-reaper';
import { runPostMortem, type RunPostMortemResult } from './post-mortem';
import { buildStatus, type OrchestratorStatus } from './status';
import { OrchestratorError } from './errors';

export interface OrchestratorOptions {
  ctx: BusContext;
  thresholds: Thresholds;
  probe: PidProbe;
  writer: PostMortemWriter;
  timeline?: ForensicTimelineWriter;
}

export interface CycleResult {
  ranAt: number;
  deadClones: DeadCloneFinding[];
  reapedLocks: LockLease[];
  reapedClaims: WorkClaim[];
  postMortems: RunPostMortemResult[];
  events: BusEvent[];
  idleClones: Array<{ clone_id: string; idle_since: number }>;
}

export class Orchestrator {
  constructor(private readonly opts: OrchestratorOptions) {}

  async runCycle(): Promise<CycleResult> {
    try {
      const ranAt = this.opts.ctx.clock.now();
      const deadClones = await findDeadClones(this.opts.ctx, {
        thresholds: this.opts.thresholds,
        probe: this.opts.probe,
      });
      const lockResult = await reapLocks(this.opts.ctx);
      const claimResult = await reapClaims(this.opts.ctx);
      const postMortems: RunPostMortemResult[] = [];
      for (const dead of deadClones) {
        try {
          const pm = await runPostMortem(this.opts.ctx, {
            cloneId: dead.clone_id,
            reason: dead.reason,
            writer: this.opts.writer,
            thresholds: this.opts.thresholds,
          });
          postMortems.push(pm);
        } catch (err) {
          // Bug #38 fix: a BusConflictError here means the clone heartbeated
          // between findDeadClones() (lock-free read) and markDead's mutator
          // (under lock). It is no longer eligible for the reaper; skip
          // silently and let the next cycle re-evaluate. Any other error is
          // a real failure and propagates.
          if (err instanceof BusConflictError) continue;
          throw err;
        }
      }
      const events = [
        ...lockResult.events,
        ...claimResult.events,
        ...postMortems.map((p) => p.event),
      ];
      const allClones = await this.opts.ctx.registry.list();
      const idleClones = allClones
        .filter((c) => c.state === 'IDLE' || c.state === 'WAITING_FOR_TASK')
        .map((c) => ({ clone_id: c.clone_id, idle_since: c.idle_since ?? c.last_heartbeat_at }));

      if (this.opts.timeline) {
        await this.opts.timeline.appendSnapshot({
          ts: ranAt,
          clones: allClones.map((c) => ({
            clone_id: c.clone_id,
            state: c.state,
            last_heartbeat_at: c.last_heartbeat_at,
            progress: c.progress,
            death_reason: c.death_reason,
            died_at: c.died_at,
          })),
        });
      }
      return {
        ranAt,
        deadClones,
        reapedLocks: lockResult.reaped,
        reapedClaims: claimResult.reaped,
        postMortems,
        events,
        idleClones,
      };
    } catch (err) {
      throw new OrchestratorError('cycle failed', { kind: 'cycle_failed', cause: err });
    }
  }

  async getStatus(): Promise<OrchestratorStatus> {
    return buildStatus(this.opts.ctx, { thresholds: this.opts.thresholds });
  }
}
