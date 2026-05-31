# Changelog

All notable changes to Manta. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-05

The first public release of Manta — **Clone Driven Development** for Claude Code. Honest-early: the core works and is tested, the rough edges are listed under _Known limitations_. `0.1.0` (not `1.0.0`) because it's young software with real caveats.

### Core

- **Self-cloning.** `manta cast <mode> --task "…"` spawns N copies of your current agent. Each clone runs in its own isolated `git worktree` on its own branch — no clone touches your working tree or another clone's.
- **Transcript inheritance.** Clones boot _warm_ — Manta forks your live session transcript into each clone (`claude --print --resume`), so a clone wakes up knowing the whole conversation. Very large transcripts fall back to a cold boot and say so loudly, never silently.
- **The bus (`manta-bus`, an MCP server).** Clones coordinate through file locks, work claims, broadcasts, heartbeats, and task contracts — no central scheduler. 31 tools total: clone-coordination plus 6 native orchestrator tools (`manta_cast`, `manta_status`, `manta_cost`, `manta_inspect`, `manta_abort`, `manta_kill`) so your agent can drive Manta with native tool calls.
- **Graceful death.** A finished clone writes a report, commits to its branch, releases its locks, and signals its own death — it never pushes; you pull.

### Modes

Nine cast modes, picked by the shape of the work:

- `recon-swarm` — read-only mapping/intel; each clone writes an audit, nothing merges.
- `bug-hunt` — a multi-layer bug with unknown cause, or a well-scoped implementation task.
- `refactor-wave` — the same change repeated across many disjoint places.
- `forking-realities` — rival approaches, built and scored, you merge the best.
- `pair-programming` — writer + reviewer loop on one risky change.
- `test-storm` — build a feature and its tests together (coder + tester + fuzzer).
- `documentation-chase` — bring docs in line with the code.
- `council` and `decoy` — opt-in advanced modes (independent proposals; a draft to react to).

### Usage guardrails

- Claude Code is a **subscription**, so the guardrails are usage/rate/parallelism — never dollars. `--max-parallel-clones`, `--max-casts-per-hour`, `--max-tokens-estimate`, plus a charge/cooldown system. Inspect with `manta cost` / `manta charges` / `manta limit`.
- A scope fence per clone (`--allowed-paths` / `--forbidden-paths` / `--max-files-changed`) is enforced by an always-on guard in the harness — not just by instructions.

### Merge-review

- After a `forking-realities` cast, Manta auto-scores the competing branches against your real quality gate (typecheck + lint + tests) and writes a merge-review with a verdict. Promote the winner with `manta promote <castId>/<cloneId>` (merges the branch, archives the losers).

### Sharing & libraries

- `manta share <cast-id>` — package a finished cast as a reusable, fully-sanitized bundle (default-deny redaction + a secret scanner + integrity checksums); optional `--publish` behind layered safety gates.
- `manta install <spec>` / `manta uninstall` / `manta library list|show|outdated|doctor` — install and manage shared Manta packages (npm scope, git URL, or local tarball), with version pinning and tamper detection on every cast.

### Distribution & tooling

- Ships as a **Claude Code plugin** (auto-registers the bus, lights up `/manta:*` commands, surfaces the skills) and as the **`@tr00x/manta`** npm CLI — a single self-contained artifact.
- `manta doctor` health-checks your environment; `manta status` / `inspect` / `tail` / `recover` give live observability; a conditional statusline shows live clones only while a cast runs.

### Known limitations

- **macOS / Linux only** — Windows isn't exercised yet.
- **Inside the Manta repo itself**, `/manta:*` collides with the installed plugin of the same name ([Claude Code #14929](https://github.com/anthropics/claude-code/issues/14929)) — use `claude --plugin-dir .` there. Users in their own projects are unaffected.
- `manta cast` runs from inside a Manta-enabled checkout (it ships with the plugin); casting from an arbitrary empty directory isn't supported.
