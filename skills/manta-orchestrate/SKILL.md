---
name: manta-orchestrate
description: The main agent's operating console for Manta — task-shape→mode router + copy-paste command recipes per mode, then observe/harvest/recover. Load BEFORE any manta cast / /manta:* / manta_* tool. Be proactive — when a task fits a cast shape, offer it.
audience: main
version: 0.2.0
related:
  - manta-cast-decide
  - manta-merge-review
  - manta-as-clone
---

# manta-orchestrate

## Purpose

You are the **main agent**. Manta clones _you_ to work in parallel. Your job once
clones run is **curator** — scope, observe, review, merge. Never climb into a
clone's worktree to co-code unless it's wedged.

This is a console, not an essay: find the task shape, copy the command, follow the
3-step loop. When unsure of a mode's contract, open its `docs/user/<mode>.md`
(map at the bottom) — **don't guess flags.**

## Allowed

### STEP 0 — Route: task shape → mode

Run `manta-cast-decide` first (cast vs solo + usage check). If it says solo, do
it solo. Otherwise pick by shape:

| The task is…                                            | Mode                  | Clones | Merges?                              |
| ------------------------------------------------------- | --------------------- | ------ | ------------------------------------ |
| "map / understand / where does X live", read-only intel | `recon-swarm`         | 1–5    | no — you read audit docs             |
| one bug, unknown cause, spans layers                    | `bug-hunt`            | 1–2    | no — produces a report (NOT commits) |
| **the same change across N files/modules**              | `refactor-wave`       | 2–5    | yes — needs a `--tasks` file         |
| **2+ real rival approaches**, want the best             | `forking-realities`   | 2+     | yes — scored, you promote one        |
| one risky change you want reviewed as it's written      | `pair-programming`    | 2      | yes — writer + reviewer              |
| build a feature **and** its tests                       | `test-storm`          | 2–3    | yes — coder + tester + fuzzer        |
| make docs match the code                                | `documentation-chase` | 1+     | docs only                            |
| N independent opinions on a hard call (advanced)        | `council`             | 3–5    | no — you decide                      |
| a throwaway draft to react to (advanced)                | `decoy`               | 1–2    | no — you finish it                   |

**Mutate+commit code?** → `refactor-wave` or `pair-programming`. **`bug-hunt`
investigates, it does not commit** — handing it "convert X and commit" stalls.

**Be proactive.** Spot a shape mid-conversation → offer it: _"that's a
refactor-wave across ~12 files — cast it?"_ / _"two real approaches here — want a
forking-realities to build both and score them?"_

### STEP 1 — Launch (copy, adapt the `--task`)

`manta cast` **blocks** until the cast finishes. Run it in the **background** (`&`)
so you can observe — or use the non-blocking `manta_cast` MCP tool (returns the
cast id the moment clones spawn).

```bash
# recon (read-only map; nothing merges)
manta cast recon-swarm --clones 2 --task "Map auth + billing: entry points, data flow, where to add X" \
  --max-files-changed 0 --allowed-paths docs/audits &

# bug-hunt (root-cause a layered bug → report)
manta cast bug-hunt --clones 1 --task "Find the root cause of the duplicate-charge bug across api→service→db" \
  --max-files-changed 0 &

# forking-realities (2 rival approaches, scored)
manta cast forking-realities --clones 2 --task "Migrate the config loader to zod" &

# pair-programming (writer + reviewer on one risky change)
manta cast pair-programming --clones 2 --task "Rewrite the rate limiter to a token bucket; reviewer gates each batch" &

# test-storm (feature + tests)
manta cast test-storm --clones 3 --task "Implement retry-with-backoff in http/client and prove it with tests" &

# refactor-wave (same change across modules) — REQUIRES a per-clone --tasks file:
manta cast refactor-wave --clones 2 --tasks .manta/wave.yaml &
```

`--tasks` YAML for refactor-wave (one entry per clone letter, **disjoint** paths):

```yaml
A:
  {
    task: 'Migrate src/auth/* to the new error type',
    scope: { allowed_paths: ['src/auth'], max_files_changed: 15 },
  }
B:
  {
    task: 'Migrate src/billing/* to the new error type',
    scope: { allowed_paths: ['src/billing'], max_files_changed: 15 },
  }
```

**Flags that matter** (full set: `docs/user/mcp-tools.md` + the mode guide):

- `--allowed-paths` / `--forbidden-paths` — scope fence (CSV). `--max-files-changed 0` = read-only.
- `--max-parallel-clones` — caps how many clones of **one cast** spawn at once (machine/rate-limit guard); default 5. NOT a cross-cast limit.
- **Concurrent casts of different modes are SAFE.** You can launch e.g. a `recon-swarm --clones 2` and a `bug-hunt --clones 1` at the same time — they get **disjoint** clone letters (the allocator treats every other cast's live letters as taken) and **cast-scoped worktrees** (`clone-<castId>-<L>`), so no collision. The only ceiling is the **5-letter global pool**: keep the SUM of live clones across all running casts ≤ 5 (e.g. 2+2+1, or one ×5). Overrun → the new cast is rejected with `concurrent_cast_limit_reached`. Tip: serial is still *simpler* to observe/harvest (`manta status` shows all casts' letters interleaved), so overlap when the parallelism is worth the bookkeeping.
- Transcript inheritance — by DEFAULT clones fork your conversation up to a **5 MB ceiling** (no flag; they boot warm). Above it they cold-boot with a loud warning, because forking a multi-MB transcript wedges the clone in STARTING (#M17). `--force-full-transcript` = fork UNCONDITIONALLY (escape hatch; can freeze on a huge session); `--no-full-transcript` = conservative 2 MB; `--distill-threshold-bytes <n>` retunes the ceiling. Structured modes (refactor-wave/test-storm) have self-contained contracts, so cold boot on a long session loses nothing.

### STEP 2 — Observe (don't busy-poll)

```bash
manta status              # live clones: state (STARTING→WORKING→WINDING_DOWN→DEAD), heartbeat, locks, claims
manta inspect <cloneId>   # one clone: contract, locks, recent events
manta tail <cloneId>      # stream a clone's events live
```

A cast is **done when every clone is DEAD**. Wait on the background job / check
`manta status` a few times — do NOT loop on it tightly. Heartbeat ticks on every
bus call; you don't watch it.

### STEP 3 — Harvest (per mode) — then VERIFY YOURSELF

- **recon-swarm / bug-hunt** → read the deliverables (audit/report docs the clones wrote). Nothing to merge.
- **forking-realities** → `cat docs/merge-reviews/<castId>.md` **FIRST**, follow `manta-merge-review`, then `manta promote <castId>/<cloneId>` to merge the winner + graveyard losers. Don't blind-merge both.
- **refactor-wave** → read `docs/merge-all-reports/<castId>.md`; each clone's branch was gated + merged sequentially.
- **pair-programming / test-storm** → review the branch diff against the contract, then merge.

**Always, before claiming green:** strip clone artifacts (`last-gasp-report.md`,
stray `node_modules`/build output) and **re-run your project's gate yourself**
(`pnpm gate` / `pytest` / `cargo test` / …). Never trust a clone's self-reported
"tests pass". Then GC: `git worktree remove --force <wt>` + `git branch -D manta/cast-*`.

If a crash left stale state: `manta recover` (reaps zombies, stale locks, missing post-mortems).

## Examples

### Map an unfamiliar codebase before changing it

```bash
manta cast recon-swarm --clones 2 --task "Map auth + billing: entry points, data flow, where to add rate-limiting" \
  --max-files-changed 0 --allowed-paths docs/audits &
```

Wait until both DEAD (`manta status`), read the two audit docs. Nothing merges —
you gained the map without spending your own context spelunking.

### Two real approaches to a migration, scored

```bash
manta cast forking-realities --clones 2 --task "Migrate the config loader to zod" &
```

Both DEAD → `cat docs/merge-reviews/<id>.md`, follow `manta-merge-review`,
`manta promote <id>/<winner>`, re-run your gate yourself, GC the branches.

### When a clone goes wrong (fast diagnosis)

- **Spawned but stuck in `STARTING`, never heartbeats** → the clone's MCP boot is slow. Manta already spawns clones with a curated MCP profile (bus + light servers; heavy LSP/indexers filtered), so this is rare; if it persists, a heavy MCP server in your `~/.claude.json` is the suspect.
- **`outcome=fail`, empty worktree, "startup grace exceeded"** → big forked transcript cold-started too slowly. Re-cast with `--startup-grace-ms 1200000`. Nothing was lost.
- **`no_candidates_passed_gate` on forking-realities** → the gate is language-aware (pnpm/npm/pytest/cargo/go); if it still fails, the candidates' tests genuinely failed — read the merge-review.
- **Clone "booted cold", didn't know the conversation** → transcript exceeded the auto-fork threshold; re-cast with `--force-full-transcript`.

## Forbidden

- **More than 5 live clones at once, total.** Clone letters are a global pool of **A–E (5)** shared across every running cast, so the SUM of live clones across all concurrent casts can't exceed 5. Overrun and the allocator rejects the new cast with `concurrent_cast_limit_reached` ("wait or abort"). Parallel casts ARE safe (see below) — they're just bounded by this 5-letter budget.
- **Busy-polling `manta status`** in a tight loop.
- **Blind-merging every branch** from a forking cast — follow the verdict.
- **Pulling a clone's whole transcript into yours** "to help" — kills the fresh-context advantage. Read its deliverable + report.
- **Claiming done/green on a clone's word** — re-run the gate yourself.
- **Casting trivial work** (<~10 min solo) — that's `manta-cast-decide`'s job to catch.
- **`bug-hunt` for a mutate+commit task** — use refactor-wave / pair-programming.

## Documentation map — open the guide before a mode you don't know cold

Per-mode guides live at `docs/user/<mode>.md` (in the repo and the installed
plugin under `${CLAUDE_PLUGIN_ROOT}/docs/`). Each has exact flags, the contract
shape, the ceremony, and a worked example:
`recon-swarm` · `bug-hunt` · `refactor-wave` · `forking-realities` ·
`pair-programming` · `test-storm` · `documentation-chase` · `council` · `decoy`.

Cross-cutting: `getting-started.md` (install, bus, first cast, limits) ·
`mcp-tools.md` (native `manta_*` tools) · `cast-manifest.md` (what a cast writes) ·
`examples/` (copy-paste end-to-end runs).

Sibling skills (load, don't reimplement): **`manta-cast-decide`** (run before
every cast) · **`manta-merge-review`** (read a forking verdict, promote a winner).
