---
name: manta-graceful-death
description: How a clone exits cleanly. TTL, kill, drift, completion — every path leaves the bus and worktree clean. Knowledge dump (≥ 1 manta.zk_write) and a final commit of deliverables are required, not optional.
audience: clone
version: 0.0.3
related: [manta-as-clone, manta-coordinate]
---

# manta-graceful-death

## Purpose

Every clone dies. The orchestrator can mark you DEAD without your cooperation, but cleanly handing over saves the post-mortem from being a guess and saves the next clone from having to clean up your mess. Run this skill when any of: TTL approaching (≤ 60 s left), main signaled `/manta kill <you>`, you noticed your own drift > 30 %, or your task is done.

The shutdown checklist is **ordered and required**. Skipping a required step is drift. Hitting all of them in order is what "graceful" means.

## Required (ordered)

The shutdown checklist below is **ordered and required**. Skipping or reordering a Required step is drift, flagged in the post-mortem.

1. **Final commit of deliverables.** `git add` every file you produced inside `taskContract.scope.allowed_paths` plus your `last-gasp-report.md`, then `git commit -m "manta-clone-${cloneId}: <one-line summary>"` on the worktree branch. The main pulls; you do not push. **A clone that calls `manta.report_death` with untracked deliverables in its worktree is in violation of this skill** — the main has had to manually `cp` files out of dead worktrees in past dogfood and that drift is over (closes bug seed #4 from `docs/post-mortems/2026-05-07-phase-2-research-cast.md`). If you genuinely produced no files, commit a single one-line marker file (`.manta/clone-${cloneId}.empty`) so the audit trail is unambiguous.
2. **Knowledge dump.** Call `manta.zk_write` **at least once**, ideally 1–3 times. Each call is one atomic note: title (kebab-case noun phrase), one-paragraph content describing the most surprising thing you learned, and `tags: ["clone-${cloneId}", "cast-${castId}", "<topic>"]`. The orchestrator flags `zk_skipped` drift on miss. If you have nothing novel, write one note titled `cast-<id>-no-novel-findings` describing what you looked at and why nothing was novel.
3. **Release everything.** `manta.unlock` every held path. `manta.release_work` every claim. Held locks WILL be reaped, but reap-events surface in the post-mortem as discipline drift.
4. **Suicide intent.** `manta.suicide_intent { reason }`. Orchestrator marks WINDING_DOWN.
5. **Last-gasp report.** Write `last-gasp-report.md` to worktree root: 1 paragraph summary + bullet list of pending items. Already committed in step 1 — do not commit again.
6. **Report death.** `manta.report_death { last_gasp_report_path }`.
7. **Exit.** `process.exit(0)` if normal, `process.exit(2)` if catastrophic.

## Allowed

- **PARA append**: high-confidence facts get `manta.para_append { category: 'projects', fact }`. Optional adjunct to ZK; not a substitute.

## Forbidden

- **Silent exits.** Exiting before `report_death` leaves the orchestrator to deduce death from heartbeat staleness — the post-mortem will be thinner. Always announce.
- **Skipping the final commit.** Untracked deliverables in a dead worktree force the main to play archaeologist. Step 1 above is non-negotiable.
- **Skipping the ZK dump.** At least one `manta.zk_write` is non-negotiable.
- **Massive ZK dumps.** 1–3 notes, atomic, each with one insight. Quality over quantity. (Spec Sec 5.5.)
- **Holding locks at exit.** They WILL be reaped, but you'll show up in `lock_reap` events and the main will know you didn't clean up.
- **Pushing to remote.** The main pulls from your worktree branch; you do not push.
- **Editing files outside your worktree on shutdown.** No "one last fix" — your scope ended when the task contract said it ended.

## Examples

TTL-approaching shutdown — the canonical ordered checklist:

1. Notice TTL is ≤ 60 s.
2. Write `last-gasp-report.md` to worktree root.
3. `git add docs/research/auth-routes.md last-gasp-report.md && git commit -m "manta-clone-A: stopped at 80% — found 12 of ~15 routes"` (Required — step 1 of the shutdown ordering).
4. **Required ZK dump** — `manta.zk_write { title: "auth-routing-pattern", content: "Routes in src/routes/*.ts compose via withAuth() → withTenant() → handler; the middleware order is load-bearing for tenant isolation", tags: ["clone-A", "cast-${castId}", "auth"] }`. Repeat 1–2 more times if there are additional surprises.
5. `manta.unlock` × held paths, `manta.release_work` × held claims.
6. `manta.suicide_intent { reason: "ttl_exhaustion: 80% complete" }`.
7. `manta.report_death { last_gasp_report_path: ".manta/worktrees/clone-A/last-gasp-report.md" }`.
8. `process.exit(0)`.

Task-complete shutdown:

Same as above but ZK content is the breakthrough that closed the task, not a gap-summary; the suicide-intent reason is `task_complete`.

Forced kill (`/manta kill A`) or orchestrator marked you DEAD due to heartbeat staleness:

1. The bus has already marked you DEAD.
2. The kill is a signal, not a gag order — finish the deliverable, then graceful-die.
3. **Still run all Required steps in order**, including the final commit. `manta.zk_write`, `manta.suicide_intent`, and `manta.report_death` may return `conflict` against a DEAD record; that's fine — call them anyway so the audit trail records intent.
4. Release locks/claims and exit.

## Daemon Mode: Task-End vs Session-End

- **Task-end (daemon):** Commit deliverables, broadcast task_complete, heartbeat IDLE. Do NOT call suicide_intent or report_death.
- **Session-end (daemon):** Full sequence: last-gasp-report, commit, zk_write, unlock/release, suicide_intent, report_death. Same as batch.
- **Batch mode:** Always full sequence (no change from current behavior).
