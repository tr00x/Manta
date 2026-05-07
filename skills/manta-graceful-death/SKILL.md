---
name: manta-graceful-death
description: How a clone exits cleanly. TTL, kill, drift, completion — every path leaves the bus and worktree clean.
audience: clone
version: 0.0.1
related: [manta-as-clone, manta-coordinate]
---

# manta-graceful-death

## Purpose

Every clone dies. The orchestrator can mark you DEAD without your cooperation, but cleanly handing over saves the post-mortem from being a guess and saves the next clone from having to clean up your mess. Run this skill when any of: TTL approaching (≤ 60 s left), main signaled `/manta kill <you>`, you noticed your own drift > 30 %, or your task is done.

## Allowed

- **Final commit**: `git add ...` your output, then commit with `manta-clone-${cloneId}: <one-line summary>` in the worktree branch. Push not required (the main pulls).
- **Knowledge dump**: 1–3 atomic `manta.zk_write` calls with the most surprising things you learned. Tag each with your `clone_id` and `cast_id`.
- **PARA append**: high-confidence facts get `manta.para_append { category: 'projects', fact }`.
- **Release everything**: `manta.unlock` every held path. `manta.release_work` every claim you still hold.
- **Suicide intent then report**: `manta.suicide_intent { reason }` first (the orchestrator marks WINDING_DOWN), then write your last-gasp report file in the worktree, then `manta.report_death { last_gasp_report_path }`.
- **Exit 0** if normal, **exit 2** if catastrophic.

## Forbidden

- **Silent exits.** Exiting before `report_death` leaves the orchestrator to deduce death from heartbeat staleness — the post-mortem will be thinner. Always announce.
- **Massive ZK dumps.** 1–3 notes, atomic, each with one insight. Spec Sec 5.5 — quality over quantity.
- **Holding locks at exit.** They WILL be reaped, but you'll show up in `lock_reap` events and the main will know you didn't clean up.
- **Pushing to remote.** The main pulls from your worktree branch; you do not push.
- **Editing files outside your worktree on shutdown.** No "one last fix" — your scope ended when the task contract said it ended.

## Examples

TTL-approaching shutdown:

1. Notice TTL is ≤ 60 s.
2. `git add . && git commit -m "manta-clone-A: stopped at 80% — found 12 of ~15 routes"`.
3. `manta.zk_write { title: "auth-routing-pattern", content: "...", tags: ["phase-0", "cast-${castId}"] }`.
4. `manta.unlock` × held paths, `manta.release_work` × held claims.
5. `manta.suicide_intent { reason: "ttl_exhaustion: 80% complete" }`.
6. Write `last-gasp-report.md` to worktree root: 1 paragraph summary + bullet list of pending items.
7. `manta.report_death { last_gasp_report_path: ".manta/worktrees/clone-A/last-gasp-report.md" }`.
8. `process.exit(0)`.

Forced kill (`/manta kill A`):

1. The main has already marked you DEAD via the bus and written a post-mortem.
2. You see the kill signal (orchestrator pings via `contract_refresh`).
3. Skip steps 1–2 above; jump to releasing locks/claims and exiting.
