---
name: manta-graceful-death
description: How a clone exits cleanly. TTL, kill, drift, completion — every path leaves the bus and worktree clean. Knowledge dump (≥ 1 manta.zk_write) is required, not optional.
audience: clone
version: 0.0.2
related: [manta-as-clone, manta-coordinate]
---

# manta-graceful-death

## Purpose

Every clone dies. The orchestrator can mark you DEAD without your cooperation, but cleanly handing over saves the post-mortem from being a guess and saves the next clone from having to clean up your mess. Run this skill when any of: TTL approaching (≤ 60 s left), main signaled `/manta kill <you>`, you noticed your own drift > 30 %, or your task is done.

The shutdown checklist is **ordered and required**. Skipping a required step is drift. Hitting all of them in order is what "graceful" means.

## Allowed

- **Final commit**: `git add ...` your output, then commit with `manta-clone-${cloneId}: <one-line summary>` in the worktree branch. Push not required (the main pulls).
- **Required: knowledge dump.** Before `manta.report_death`, call `manta.zk_write` **at least once**, ideally 1–3 times. Each call is one atomic note: title (kebab-case noun phrase), one-paragraph content describing the most surprising thing you learned, and `tags: ["clone-${cloneId}", "cast-${castId}", "<topic>"]`. **A clone that calls `manta.report_death` without at least one prior `manta.zk_write` is in violation of this skill.** The orchestrator's post-mortem flags this as `zk_skipped` drift in Phase 2+; for now it's a quality-of-shutdown signal you owe the cast.
- **PARA append**: high-confidence facts get `manta.para_append { category: 'projects', fact }`.
- **Release everything**: `manta.unlock` every held path. `manta.release_work` every claim you still hold.
- **Suicide intent then report**: `manta.suicide_intent { reason }` first (the orchestrator marks WINDING_DOWN), then write your last-gasp report file in the worktree, then `manta.report_death { last_gasp_report_path }`.
- **Exit 0** if normal, **exit 2** if catastrophic.

## Forbidden

- **Silent exits.** Exiting before `report_death` leaves the orchestrator to deduce death from heartbeat staleness — the post-mortem will be thinner. Always announce.
- **Skipping the ZK dump.** At least one `manta.zk_write` is non-negotiable. If you genuinely have nothing to record (rare — most casts produce at least one surprise), write a single ZK note with title `cast-<id>-no-novel-findings` and content stating what you looked at and why nothing was novel. The point is the audit trail, not padding.
- **Massive ZK dumps.** 1–3 notes, atomic, each with one insight. Quality over quantity. (Spec Sec 5.5.)
- **Holding locks at exit.** They WILL be reaped, but you'll show up in `lock_reap` events and the main will know you didn't clean up.
- **Pushing to remote.** The main pulls from your worktree branch; you do not push.
- **Editing files outside your worktree on shutdown.** No "one last fix" — your scope ended when the task contract said it ended.

## Examples

TTL-approaching shutdown — the canonical ordered checklist:

1. Notice TTL is ≤ 60 s.
2. `git add . && git commit -m "manta-clone-A: stopped at 80% — found 12 of ~15 routes"`.
3. **Required ZK dump** — `manta.zk_write { title: "auth-routing-pattern", content: "Routes in src/routes/*.ts compose via withAuth() → withTenant() → handler; the middleware order is load-bearing for tenant isolation", tags: ["clone-A", "cast-${castId}", "auth"] }`. Repeat 1–2 more times if there are additional surprises.
4. `manta.unlock` × held paths, `manta.release_work` × held claims.
5. `manta.suicide_intent { reason: "ttl_exhaustion: 80% complete" }`.
6. Write `last-gasp-report.md` to worktree root: 1 paragraph summary + bullet list of pending items.
7. `manta.report_death { last_gasp_report_path: ".manta/worktrees/clone-A/last-gasp-report.md" }`.
8. `process.exit(0)`.

Task-complete shutdown:

Same as above but ZK content is the breakthrough that closed the task, not a gap-summary; the suicide-intent reason is `task_complete`.

Forced kill (`/manta kill A`):

1. The main has already marked you DEAD via the bus and written a post-mortem.
2. You see the kill signal (orchestrator pings via `contract_refresh`).
3. **Still write at least one ZK note** if you have time before the SIGTERM-grace expires — the kill is a signal, not a gag order.
4. Release locks/claims and exit.
