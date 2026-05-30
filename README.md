# Manta

**Manta makes Claude Code clone *itself* to work in parallel — same system prompt, your full conversation inherited, each clone in its own isolated git worktree, coordinating over a message bus.**

It is not a multi-agent framework with specialized roles. There is no "researcher agent" and "coder agent." When you cast Manta, you spawn copies of the *same* agent you're already talking to — each one starts with everything you've discussed, then goes off and does real work (writes code, runs tests, commits) on its own branch, in parallel.

---

## TL;DR

- You're in a Claude Code session. You hit a task that's big, repetitive, or has independent parts.
- You run `manta cast <mode> --task "..."`. Manta spawns N clones of your current agent.
- Each clone gets its **own git worktree** (isolated working copy), **your full transcript** (so it knows what you know), and a **task contract**.
- Clones work in parallel, coordinate through a bus (file locks, work claims, broadcasts), commit to their own branches, and shut down cleanly.
- You (the main agent) review their output, merge the good work, and keep going.

The point: **parallelism without losing context, and without the overhead of designing a role hierarchy.** A clone is just *you*, again, somewhere else.

---

## Why it exists (the problem)

Claude Code already has subagents (the `Agent` tool). They're useful, but they have two limits:

1. **They start cold.** A subagent gets a fresh context. It doesn't know what you and the user just spent an hour figuring out. You have to re-explain, or accept that it'll re-derive (and sometimes re-break) things.
2. **They're one-shot helpers, not parallel workers.** They return a message; they don't own a branch, hold a lock, or coordinate with siblings on a shared codebase.

Existing multi-agent frameworks (CrewAI, AutoGPT, LangGraph) answer parallelism with **role specialization** — you design a crew (a planner, a researcher, a writer), wire them together, and maintain that graph. That's powerful but it's *work*, and the roles are assumptions you bake in before you know the problem.

Manta takes the opposite bet: **don't specialize, clone.** The agent that already understands the problem (because it's been in the conversation) is the best worker for it. So Manta forks *that* agent — same system prompt, same transcript — N times, and lets the copies divide the work dynamically through coordination primitives instead of a fixed role graph.

This is a deliberate paradigm difference. As far as we know, Manta is the first same-system-prompt, full-transcript-inheritance cloning pattern for Claude Code.

---

## Who it's for

- **Claude Code users working on real, non-trivial codebases** — where a task spans many files, has several independent sub-tasks, or benefits from trying more than one approach.
- People who want **parallel execution they can trust**: real commits on real branches, gated by real tests, not a demo.
- People who'd rather **describe a task and review results** than micro-manage a multi-agent role graph.

If your task takes you 5 minutes solo, don't cast — just do it. Manta earns its keep when the work is big, branchy, or repetitive.

---

## How it actually works

A cast goes through a real lifecycle. Here's what happens when you run a forking cast with 2 clones:

```
manta cast forking-realities --clones 2 --task "Add rate limiting to the API"
```

1. **Allocate & isolate.** Manta picks 2 clone slots (letters A, B) and creates a **git worktree** for each under `.manta/worktrees/` — a separate checkout on its own branch (`manta/cast-<id>/A`, `.../B`). Clones never stomp on your working tree or each other's.

2. **Inherit your context.** Manta finds your current Claude session's transcript and **forks a copy** into each clone's worktree, then boots the clone with `claude --print --resume <forked-transcript>`. The clone wakes up knowing the whole conversation — the design you settled on, the constraints, the file you were just looking at. (For very large transcripts there's a size threshold; over it, the clone boots without inheritance and says so loudly — never silently.)

3. **Hand off a contract.** Each clone gets a **task contract**: what to build, its scope fence (which paths it may touch), its budget, and success criteria. It acknowledges the contract on the bus before starting.

4. **Work in parallel, coordinate on the bus.** Clones run independently but talk through the **Manta bus** (an MCP server). They take **file locks** (so two clones don't edit the same file), **claim work items**, **broadcast** findings to each other, and **heartbeat** so the orchestrator knows they're alive. No clone can silently corrupt shared state.

5. **Commit & die gracefully.** When done, a clone writes a report, commits its work to its branch, records a one-paragraph "most surprising thing I learned" note, releases its locks, and signals its own death. It does **not** push — the main agent pulls.

6. **You review & merge.** For `forking-realities`, Manta scores the competing branches (a quality gate that mirrors your canonical `pnpm gate`) and writes a **merge-review** with a verdict. You read it, pick the winner, code-review the diff, and merge. The losing branch's good ideas can be cherry-picked.

`recon-swarm` (read-only) is simpler: clones explore and each writes an audit document; nothing gets merged, you just get the intelligence.

### The pieces

| Piece | What it is |
|---|---|
| **Worktrees** | Each clone gets an isolated `git worktree` on its own branch. Isolation is real, not cooperative. |
| **Transcript inheritance** | Clones boot from a fork of your live session transcript via `claude --resume`. They start *warm*. |
| **The bus (MCP server)** | `manta-bus` — locks, work claims, broadcasts, heartbeats, task contracts, ZK notes. How clones coordinate without a central scheduler. |
| **Task contracts** | The explicit spec + scope fence + budget each clone agrees to before working. |
| **Charges & budgets** | A rate/cost system (`manta charges`, `manta cost`, `manta limit`) so a cast can't run away with your money or your machine. |
| **Merge-review** | For competing branches, an automated quality-gated score + verdict you follow when merging. |
| **Skills** | Markdown behavior contracts (`manta-as-clone`, `manta-graceful-death`, …) that tell clones how to behave. Shipped with the plugin. |

---

## Install

Manta ships two ways. **The Claude Code plugin is the primary path** — it lights up `/manta:*` slash commands, surfaces Manta's skills to your session and to spawned clones, and auto-registers the `manta-bus` MCP server. The **npm CLI** is the terminal / power-user path.

### Plugin (recommended)

From inside Claude Code:

```
/plugin marketplace add tr00x/Manta
/plugin install manta@manta
```

Then reload. You now have:

- **`/manta:cast`, `/manta:status`, `/manta:abort`, `/manta:cost`** (plus `kill`, `promote`, `recover`) — slash commands that wrap the bundled `manta` binary.
- **Manta's skills** in your skill list (e.g. `manta-cast-decide` — "should I even cast this?"), and resolvable by spawned clones.
- **The `manta-bus` MCP server**, registered automatically — no `claude mcp add`, no manual setup.

To test a local checkout without the marketplace:

```
claude --plugin-dir /path/to/Manta     # loads /manta:* for that session
claude plugin validate /path/to/Manta  # checks the manifest
```

### npm CLI (terminal / power-user)

```
npx manta@latest install                 # registers the manta-bus MCP server
manta cast recon-swarm --clones 2 --task "Map this codebase"
```

> **Note (npm path):** the CLI's `cast` works best from inside a Manta-enabled checkout that carries the `skills/` directory. The plugin path has no such precondition — skills ship with the plugin.

Full walkthrough: [`docs/user/getting-started.md`](docs/user/getting-started.md). Plugin internals: [`docs/internals/plugin-packaging.md`](docs/internals/plugin-packaging.md).

---

## Your first cast (worked example)

Say you're mid-session and want to understand an unfamiliar codebase before changing it. That's a read-only mapping job — perfect for `recon-swarm`:

```
manta cast recon-swarm --clones 2 \
  --task "Map the auth and billing subsystems: entry points, data flow, where to add a feature" \
  --max-files-changed 3 --allowed-paths "docs/audits"
```

What you'll see:

```
manta status
Clone | Mode         | State    | Heartbeat age | Locks | Claims
A     | recon-swarm  | WORKING  | 2s            | -     | -
B     | recon-swarm  | WORKING  | 4s            | -     | -
```

Each clone reads the codebase (warm — it already knows from your conversation what you care about) and writes an audit document under `docs/audits/`. When they finish, you read two focused write-ups instead of having spelunked the code yourself — and your own context window stayed clean.

For implementation work where there's a genuine "which approach?" question:

```
manta cast forking-realities --clones 2 --task "Migrate the config loader to zod"
```

Two clones each build it their own way. Manta scores both, writes `docs/merge-reviews/cast-<id>.md` with a verdict, and you merge the winner.

Stop everything at any time:

```
manta abort
```

---

## Modes

A "mode" sets how clones behave and how many spawn. Pick by the shape of the work.

| Mode | Clones | Use when |
|---|---|---|
| `recon-swarm` | 1+ | **Read-only.** Map a codebase, gather intelligence, write audits. Nothing merges. |
| `forking-realities` | 2 | There are **2+ non-obvious approaches** and you want them built and scored, then merge the best. |
| `bug-hunt` | 1+ | A multi-layer bug, or a list of known fixes to apply with root-cause discipline. |
| `refactor-wave` | 2 | The **same migration pattern** repeated across N places. |
| `test-storm` | 2 | Generate/strengthen tests across a surface. |
| `pair-programming` | 2 | Writer + reviewer loop on one change. |
| `documentation-chase` | 1+ | Bring docs in line with reality. |
| `council`, `phantom-lance`, `decoy` | 3 | Advanced modes — gated behind a 90-day production-maturity gate. |

Not sure if a task is worth casting? The `manta-cast-decide` skill is a built-in gut-check. Rule of thumb: **cast if the task is >10 minutes, reads across many files, has independent parts, or has competing approaches. Don't cast trivial work.**

---

## CLI reference (the essentials)

```
manta cast <mode> --task "..."   Spawn clones for a mode
manta status                     Active clones, their state, locks, claims
manta inspect <cloneId>          Deep-dive one clone: contract, locks, events
manta tail <cloneId>             Stream a clone's events live
manta promote <castId/cloneId>   Merge the winning branch of a forking cast
manta abort                      Stop all active clones now
manta recover                    Clean up stale state after a crash
manta cost [period]              Spend summary
manta charges                    Charge/cooldown state + which modes are available
manta limit                      Read/write budget config
```

Daemon (persistent clones), `share` (publish a cast as a reusable package), and `library` (install shared Manta packages) round out the surface — run `manta --help` for the full list.

---

## How ready is it?

Honest status — this is `0.1.0`, early but real, not a toy and not a demo.

**Works and is verified (real tests, run independently — no self-reported green):**

- ✅ **Transcript inheritance** — clones provably boot with the caster's context (acceptance e2e reproduces a parent-only sentinel token; a negative control inherits nothing).
- ✅ **Isolation & coordination** — worktrees, the bus (locks/claims/broadcasts/heartbeats), task contracts, graceful death.
- ✅ **All 7 built-in modes** operational; 25 MCP tools on the bus.
- ✅ **Merge-review quality gate** mirrors the canonical `pnpm gate` (typecheck + lint + tests) before scoring branches.
- ✅ **Charges, budgets, cooldowns** — runaway-cost guardrails.
- ✅ **Distribution** — single self-contained npm artifact + a validated Claude Code plugin (`claude plugin validate` passes).
- ✅ Gate: **171 test files / 1462 tests green.**

**Known limitations (tracked in [`docs/manta-bugs.md`](docs/manta-bugs.md)):**

- ⚠️ **Large parent transcripts slow clone cold-start** (#66). Late in a very long session the transcript can grow big enough that a clone's boot exceeds the 300s startup grace and it's reaped before its first heartbeat. Workaround: `--startup-grace-ms 600000`, or cast from a fresher session. Being fixed.
- ⚠️ **Concurrent *separate* casts** share a clone-letter namespace; a data-loss guard is in place, but the fully structural fix (cast-scoped worktree paths) is post-`0.1.0`. For now, run casts serially.
- ⚠️ A short list of reliability/polish follow-ups (see the bug log) — none block normal use.

**Phases 0–7** of the internal build are complete (see [`CHANGELOG.md`](CHANGELOG.md)); Phase 8 (advanced modes) is gated behind production maturity.

---

## Design & internals

- **Design spec (source of truth):** [`docs/superpowers/specs/2026-05-06-manta-pattern-design.md`](docs/superpowers/specs/2026-05-06-manta-pattern-design.md)
- **Getting started:** [`docs/user/getting-started.md`](docs/user/getting-started.md)
- **Forking-realities deep dive:** [`docs/user/forking-realities.md`](docs/user/forking-realities.md)
- **Plugin packaging:** [`docs/internals/plugin-packaging.md`](docs/internals/plugin-packaging.md)
- **Bug log (lived-in, honest):** [`docs/manta-bugs.md`](docs/manta-bugs.md)

---

## License

MIT — see [`LICENSE`](LICENSE).
