---
name: manta-orchestrate
description: End-to-end playbook for the main agent driving Manta. After you decide to cast, how to launch, observe, review, merge, and recover — plus the reliability gotchas that bite in real projects.
audience: main
version: 0.0.1
related:
  - manta-cast-decide
  - manta-merge-review
  - manta-as-clone
---

# manta-orchestrate

## Purpose

You are the **main agent** in a Claude Code session, working on the user's project. Manta lets you clone yourself to work in parallel. `manta-cast-decide` told you *whether* to cast and which mode. This skill is the **operating playbook for everything after that decision**: launching the cast, watching it without wasting tokens, reviewing what clones produced, merging the good work, and recovering from the failure modes that actually happen on large projects.

Your role once clones are running is **curator, not co-implementer**: you scope, observe, review, and merge. You do **not** climb into a clone's worktree and code alongside it unless it's wedged.

## Allowed

**The end-to-end flow:**
1. **Decide** — run `manta-cast-decide` first. If it says "solo", do it solo. Don't cast to feel productive.
2. **Scope a contract** — give the cast a precise `--task` (or a per-clone `--tasks` file), a scope fence (`--allowed-paths` / `--forbidden-paths`), budgets (`--budget-per-clone-usd`, `--budget-per-cast-usd`), and `--max-files-changed` (>0 if clones must write deliverables; 0 = read-only).
3. **Launch** — `manta cast <mode> --task "…"`. The CLI prints a cast id. `manta cast` forks the orchestrator and the clones; treat the launch returning as "started", **not** "finished".
4. **Observe** — `manta status` shows clone states (STARTING → WORKING → WINDING_DOWN → DEAD), heartbeats, locks, claims. Use `manta inspect <cloneId>` for one clone's contract/locks/events, `manta tail <cloneId>` to stream live, `manta replay <castId>` after the fact. Read broadcasts for cross-clone findings.
5. **Wait for completion** — a cast is done when **every** clone is DEAD (or the orchestrator settles). Check `manta status` a few times, or wait on the orchestrator process — don't busy-poll.
6. **Ceremony** —
   - `recon-swarm` (read-only): harvest the clones' deliverables (audit docs); nothing merges.
   - `forking-realities`: **read `docs/merge-reviews/<castId>.md` FIRST**, then follow `manta-merge-review`. Don't blind-merge both branches.
   - implementation modes: review each branch's diff against the contract before merging.
7. **Harvest & merge** — cherry-pick / merge the winning work. **Strip clone artifacts** that shouldn't land on your main branch (a clone's `last-gasp-report.md`, any accidentally-committed `node_modules`/build output). Re-run your project's gate (e.g. `pnpm gate` / `npm test`) **yourself** before claiming green — don't trust a clone's self-reported "tests pass".
8. **Recover & clean** — `manta recover` reaps stale state after a crash. GC finished worktrees/branches once their work is harvested.

**Reliability gotchas (these bite on real, large projects):**
- **Run casts SERIALLY.** Two casts overlapping in time can collide on clone-letter/worktree allocation (a data-loss guard exists, but the structural fix is pending). Wait for one cast's clones to be DEAD before launching the next.
- **Cast from a reasonably fresh session.** A clone boots by forking your current transcript. Late in a *very* long session the transcript gets large and clone cold-start can exceed the 300s startup grace → the clone is reaped before its first heartbeat (`outcome=fail`, empty worktree). Workaround: `--startup-grace-ms 600000`, or start the cast from a fresher session.
- **Mind the budget.** Every cast costs charges + money + some of your own context. Check `manta charges` / `manta cost`. A forking cast where one clone does heavy work can starve a sibling on the shared tick-budget.
- **Single-clone tasks: pass the task inline** (`--task "$(cat task.txt)"`) rather than a per-clone `--tasks` file — clone-letter keys in the file must match the allocated roster, which you don't control.

## Forbidden

- **Launching parallel casts simultaneously.** Serial only — see the collision gotcha above.
- **Busy-polling `manta status` in a tight loop.** Observe via background waits + a few state-transition checks. Heartbeat is implicit on every bus call; you don't need to watch it tick.
- **Blind-merging every branch from a forking cast** "because both look useful". Follow the merge-review verdict; cherry-pick the loser's good bits deliberately.
- **Pulling a clone's full context into your own transcript** "to help". That destroys the fresh-context advantage you cloned for. Read its deliverable + report, not its whole session.
- **Claiming "done / green" on a clone's word.** Re-run the gate yourself.
- **Casting trivial work** (< ~10 min solo). That's `manta-cast-decide`'s job to catch.
- **Climbing into a clone's worktree to co-code** unless it's genuinely stuck. You're the curator.

## Examples

**Map an unfamiliar codebase before changing it.**
`manta cast recon-swarm --clones 2 --task "Map auth + billing: entry points, data flow, where to add X" --max-files-changed 3 --allowed-paths docs/audits`. Watch `manta status` until both DEAD. Read the two audit docs. Nothing to merge — you just gained the map without spending your own context spelunking.

**Two genuine approaches to a migration.**
`manta cast forking-realities --clones 2 --task "Migrate config loader to zod"`. Wait for both DEAD. `cat docs/merge-reviews/<id>.md`, follow `manta-merge-review`, code-review the winner's diff, merge, re-run your gate yourself, then GC the branches.

**A second task while the first is still running.**
Don't. `manta status` shows clones still WORKING → wait. Launching now risks a worktree collision. Queue it.

**Cast failed with `outcome=fail`, empty worktree, "startup grace exceeded".**
Your session transcript is large and the clone couldn't cold-start in time. Retry with `--startup-grace-ms 600000`, or run the cast from a fresh session. Nothing was lost (the worktree is clean).

**A clone committed `node_modules` or a `last-gasp-report.md` to its branch.**
Strip those before merging — they're clone artifacts, not deliverables. Merge only the real change.
