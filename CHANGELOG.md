# Changelog

All notable changes to Manta. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Reliability and cross-language hardening from dogfooding Manta on a large real project (a heavy-MCP, long-running session).

### Changed

- **Clones inherit the FULL parent transcript by default.** Previously a parent transcript larger than `--distill-threshold-bytes` (2 MB) was skipped unless you passed `--force-full-transcript` on every cast — so long sessions silently cold-booted clones without their context. Full-transcript inheritance is now the default. `--force-full-transcript` still works as an escape hatch — it lifts the size ceiling entirely (fork the full transcript no matter how large) where the default keeps a safe ceiling; pass `--no-full-transcript` to opt out and re-enable the size guard (clones boot without inherited context, avoiding a huge transcript × N copies). `--distill-threshold-bytes` now applies only with `--no-full-transcript`. The boot-reap risk that motivated the old guard is covered by the booting-ticker, the roomier fix-mode startup grace, and the curated MCP profile.
- **Clones boot with a curated MCP profile, not your whole stack.** A spawned clone used to inherit every MCP server from your `~/.claude.json`. On a big repo that meant a language-server MCP (e.g. serena with `--project-from-cwd`) cold-indexed the whole project inside *each* clone's worktree, wedging the clone's boot until it was reaped before it could start. Clones are now spawned with `--strict-mcp-config` and a generated config containing `manta-bus` plus your *light* servers (context7, claude-mem, …); heavy boot-wedgers (language servers / LSP, computer-use, desktop control) are filtered out. A clone is still a capable implementer — it just doesn't drag a per-worktree index into startup. Measured: clone cold-boot dropped from tens of seconds (often hanging) to ~5s.
- **The quality gate is now language-aware.** `forking-realities` merge-review and `refactor-wave` merge-all used to hardcode the pnpm/TypeScript toolchain, so on a non-JS project every candidate was silently disqualified ("no candidate passed the gate") because `pnpm test` errored — the tests never ran. The gate now detects the project type at the worktree root and runs the right commands for **test, typecheck, and lint**: pnpm/npm (`tsc`/eslint), Python (`pytest`), Rust (`cargo test`/`cargo check`), Go (`go test`/`go vet`). A tool that isn't installed, or an axis that doesn't apply, is skipped (neutral) rather than penalising the candidate. forking-realities/refactor-wave now work on Python/Go/Rust repos, not just TypeScript.
- **Long fix casts get a roomier heartbeat by default.** Modes that write code and run a test suite (`refactor-wave`, `bug-hunt`, `pair-programming`, `test-storm`) can have multi-minute gaps between tool calls; the old 300s default reaped an actively-working clone mid-edit and lost the work silently. Those modes now default to a 20-minute heartbeat timeout, a 15-minute startup grace, and a 60-minute tick budget. Read/quick modes keep the tight default. An explicit `--heartbeat-timeout-ms` / `--startup-grace-ms` still wins — and if you pass one *below* the safe default for a fix mode, Manta now warns instead of silently weakening the protection.

### Fixed

- **Pair-programming, test-storm, and documentation-chase actually run more than one turn now.** These "daemon" modes are built so a clone does an initial turn, then is *resumed* with new work the orchestrator hands it (the pair reviewer reviews each writer commit; the test-storm tester reacts to new code; the doc-chaser walks a queue of files). That resume loop was never wired into the cast command — a clone ran exactly one turn and then sat idle forever, so a pair-programming cast silently collapsed to a lone writer (the reviewer never saw the writer's commit) and test-storm/doc-chase stalled after the first step. The cast now drives each daemon clone's subsequent turns: it dequeues the work the dispatcher enqueues and resumes the clone's session (keeping the same curated MCP profile, and killing an in-flight resumed turn cleanly on abort so nothing is orphaned), with idle timeouts roomy enough that a clone waiting on its partner isn't reaped mid-cast. Verified end-to-end on a real pair cast: writer commits → reviewer is resumed → reviewer approves → cast settles success. Two boot-level bugs surfaced and fixed along the way: a daemon clone's session id is now a valid UUID (the binary rejects anything else, which had killed clones on boot), and a clone's broadcasts now carry the sender id where the dispatcher reads it (so the writer↔reviewer handoff actually matches).
- **Clones can register with the bus from their worktree again.** A clone runs in a `git worktree`, whose `.git` is a gitfile rather than a directory. The clone's `manta-bus` server resolved its state directory by walking up to that gitfile and stopped at the *worktree* — an empty registry — while the spawner had pre-registered the clone in the *main* repo. Every clone heartbeat then came back "unknown clone" and the clone hung at startup until it was reaped. The bus now (a) is launched with the main repo root pinned in its environment, and (b) recognises a worktree gitfile and resolves to the main working tree. Clones leave startup, ack their contract, work, and settle normally. (This surfaced only once the curated MCP profile stopped the parent environment from masking it.)
- **Clone coordination tools accept numeric arguments again.** The `--print`-mode MCP bridge serializes numeric tool arguments as strings, so `manta.claim_work { timeout_ms: 30000 }` reached the bus as `"30000"` and was rejected — breaking the work-claim board and other numeric bus calls from clones. Numeric MCP parameters now coerce a clean integer string, so the claim board, retask, and registration work from clones.
- **Pair-programming reviewers are no longer reaped while waiting on the writer.** A reviewer goes idle waiting for the writer's first commit; the writer's first batch routinely exceeds the idle timeout, so the reviewer was always reaped first and the pair silently degraded to a lone writer. A reviewer is now exempt from the idle reap while its paired writer is alive (a genuinely hung reviewer is still caught by the heartbeat timeout).
- **Post-mortem timelines no longer mix casts.** Reused clone letters (A/B/C across casts) made a post-mortem inherit the previous cast's events. Each clone's timeline is now scoped to its own incarnation.
- **`bug-hunt` warns on a mutate-and-commit task.** `bug-hunt` is investigation-only (it produces a report, never commits); a contract telling it to "convert and commit" stalled silently. Manta now warns at cast time and points you at `refactor-wave` / `pair-programming` for code changes.
- **Your project's `CLAUDE.md` reaches clones** even when it's gitignored — copied into each clone's worktree at spawn (opt out with `--no-inherit-instructions`), so clones honor your project's standards, not just the conversation.

### Removed

- **No more dollars, charges, or cooldown.** Claude Code is a subscription, so the per-cast "cost", the charge ledger, the cooldown, and the `--max-casts-per-hour` / `--max-tokens-estimate` flags were removed, along with the `cost` / `charges` / `refresh` commands and the `manta_cost` MCP tool. The one remaining usage limit is `--max-parallel-clones`.

## [0.1.0] — 2026-05

The first public release of Manta — **Clone Driven Development** for Claude Code. Honest-early: the core works and is tested, the rough edges are listed under _Known limitations_. `0.1.0` (not `1.0.0`) because it's young software with real caveats.

### Core

- **Self-cloning.** `manta cast <mode> --task "…"` spawns N copies of your current agent. Each clone runs in its own isolated `git worktree` on its own branch — no clone touches your working tree or another clone's.
- **Transcript inheritance.** Clones boot _warm_ — Manta forks your live session transcript into each clone (`claude --print --resume`), so a clone wakes up knowing the whole conversation. Very large transcripts fall back to a cold boot and say so loudly, never silently.
- **The bus (`manta-bus`, an MCP server).** Clones coordinate through file locks, work claims, broadcasts, heartbeats, and task contracts — no central scheduler. 30 tools total: clone-coordination plus 5 native orchestrator tools (`manta_cast`, `manta_status`, `manta_inspect`, `manta_abort`, `manta_kill`) so your agent can drive Manta with native tool calls.
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

- Claude Code is a **subscription**, so the only guardrail is parallelism — never dollars, and there are no charges or cooldowns. `--max-parallel-clones` caps how many clones run at once; inspect/set it with `manta limit`.
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
