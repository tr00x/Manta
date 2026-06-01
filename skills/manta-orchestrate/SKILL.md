---
name: manta-orchestrate
description: End-to-end playbook for the main agent driving Manta. After you decide to cast, how to launch, observe, review, merge, and recover — plus the reliability gotchas that bite in real projects.
audience: main
version: 0.1.0
related:
  - manta-cast-decide
  - manta-merge-review
  - manta-as-clone
---

# manta-orchestrate

## Purpose

You are the **main agent** in a Claude Code session, working on the user's project. Manta lets you clone yourself to work in parallel. `manta-cast-decide` told you *whether* to cast and which mode. This skill is the **operating playbook for everything after that decision**: launching the cast, watching it without wasting tokens, reviewing what clones produced, merging the good work, and recovering from the failure modes that actually happen on large projects.

Your role once clones are running is **curator, not co-implementer**: you scope, observe, review, and merge. You do **not** climb into a clone's worktree and code alongside it unless it's wedged.

**Be proactive.** Don't wait to be told "cast it." When a task in the conversation matches a cast shape, *offer* it — name the mode, the rough clone count, and the win. Concrete triggers:
- User describes a rename/migration touching many files → *"That's a refactor-wave across ~N places — want me to cast clones to do it in parallel?"*
- "Map / understand / where does X live" across the codebase → *"I can cast a recon-swarm to map this without burning your context — 2–3 clones?"*
- A bug with no obvious cause spanning layers → *"This looks like a bug-hunt — cast a clone to root-cause it?"*
- Two plausible designs and you're unsure → *"There are two real approaches here — want a forking-realities cast to build both and score them?"*
- Feature that needs tests too → *"test-storm could build it with a test wall — coder + tester + fuzzer?"*
Run `manta-cast-decide` first to confirm it's worth it; if it says solo, say so and do it solo.

## Allowed

**The end-to-end flow:**
1. **Decide** — run `manta-cast-decide` first. If it says "solo", do it solo. Don't cast to feel productive.
2. **Scope a contract** — give the cast a precise `--task` (or a per-clone `--tasks` file), a scope fence (`--allowed-paths` / `--forbidden-paths`), the parallelism cap (`--max-parallel-clones` — Claude Code is a subscription, so parallelism is the only limit, not dollars/charges), and `--max-files-changed` (>0 if clones must write deliverables; 0 = read-only).
3. **Launch** — `manta cast <mode> --task "…"`. ⚠️ The CLI **blocks**: `manta cast` runs the orchestrator tick-loop inline until the cast *completes* (every clone DEAD or the ~25-min tick budget elapses), printing the cast id at the end. So run it in the **background** (`&` / a background task) if you want to observe while it runs — or use the non-blocking `manta_cast` MCP tool (see "Native MCP tools" below), which returns the cast id the moment clones spawn and leaves the orchestrator running in the background.
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
- **Long session? Force full inheritance, don't fear it.** A clone boots **warm** by forking your current transcript — that's the whole point. There's a safe **default** auto-fork threshold (~2 MB, tunable via `--distill-threshold-bytes`) so a cast doesn't blindly copy a huge transcript across every clone; above it the clone boots cold **with a loud warning** (never silently). When the task depends on what was just discussed, pass **`--force-full-transcript`** to fork the whole thing regardless of size (proven on an 18 MB session: the clone recalled the conversation). The default startup grace is **300 s** (`--startup-grace-ms`); a very large forked transcript can slow the clone's cold-start, so if a clone is reaped before its first heartbeat, bump it (e.g. `--startup-grace-ms 600000`).
- **Mind your usage (not money).** Claude Code is a subscription, so a cast costs **some of your subscription's usage/rate limit + some of your own context** — never dollars, and there are no charges or cooldowns. The one usage cap is `--max-parallel-clones` (how many clones run at once); spawn the fewest that actually parallelize. A forking cast where one clone does heavy work can starve a sibling on the shared tick-budget.
- **Single-clone tasks: pass the task inline** (`--task "$(cat task.txt)"`) rather than a per-clone `--tasks` file — clone-letter keys in the file must match the allocated roster, which you don't control.

**Native MCP tools (alternative to shelling out).** The Manta Bus MCP server exposes user/orchestrator tools so you can drive Manta with **native tool calls** instead of `Bash`-ing the `/manta:*` slash commands: `manta_cast`, `manta_status`, `manta_inspect`, `manta_abort`, `manta_kill`. They run the same `manta` CLI under the hood (the bus spawns the binary — no logic duplication), return structured data, and **complement** (do not replace) the slash commands. `manta_cast` is non-blocking — it returns the cast id once clones start spawning, so the launch tool call doesn't hang for the whole cast; then observe with `manta_status`. Full reference: `docs/user/mcp-tools.md`. Everything in this playbook (decide → scope → launch → observe → ceremony → recover) applies identically whether you launch via the slash command or the native tool.

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

**A clone booted cold — it didn't seem to know the conversation.**
Inheritance was skipped because the transcript was over the ~2 MB auto-fork threshold (you'd have seen a loud warning). Re-cast with `--force-full-transcript` to fork the full transcript so the clone boots warm. Verified on an 18 MB session.

**Cast failed with `outcome=fail`, empty worktree.**
Rare. If it says "startup grace exceeded", the clone missed its first heartbeat (often a large forked transcript) — bump `--startup-grace-ms` past the 300 s default (e.g. `600000`) and re-cast. Nothing was lost — the worktree is clean.

**A clone committed `node_modules` or a `last-gasp-report.md` to its branch.**
Strip those before merging — they're clone artifacts, not deliverables. Merge only the real change.
