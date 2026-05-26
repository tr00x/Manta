import type { BusContext, BusEvent, LockLease, WorkClaim } from '@manta/bus';
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
        const pm = await runPostMortem(this.opts.ctx, {
          cloneId: dead.clone_id,
          reason: dead.reason,
          writer: this.opts.writer,
          thresholds: this.opts.thresholds,
        });
        postMortems.push(pm);
      }
      const events = [
        ...lockResult.events,
        ...claimResult.events,
        ...postMortems.map((p) => p.event),
      ];
      if (this.opts.timeline) {
        const allClones = await this.opts.ctx.registry.list();
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
      };
    } catch (err) {
      throw new OrchestratorError('cycle failed', { kind: 'cycle_failed', cause: err });
    }
  }

  async getStatus(): Promise<OrchestratorStatus> {
    return buildStatus(this.opts.ctx, { thresholds: this.opts.thresholds });
  }
}
