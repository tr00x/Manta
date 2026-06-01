# Manta — Getting Started

> **Prerequisites:** Node ≥ 20, pnpm ≥ 9, git, an installed and authenticated `claude` CLI. macOS or Linux. All 9 cast modes ship: `recon-swarm`, `bug-hunt`, `refactor-wave`, `forking-realities`, `pair-programming`, `test-storm`, `documentation-chase`, plus the Aghs-locked `council` and `decoy` (opt-in). This walkthrough uses `recon-swarm` as the gentle first cast.

## 1. Clone & install

```
git clone <manta-repo>
cd manta
pnpm install
pnpm -r build
```

Expected: every workspace package emits a `dist/`. If any package fails: read its build log; the predecessor plan's verification steps will tell you what's expected.

## 2. Register the Manta Bus as an MCP server

**This step is mandatory.** Real `claude --print` clones spawned by `manta cast` need to talk to `manta-bus` over MCP — without this registration every clone-side tool call fails at the transport layer and the cast times out silently.

How you register depends on how you got Manta. Pick **one** of the three paths below — they are mutually exclusive.

### a) Claude Code plugin (recommended) — nothing to type

If you installed the plugin (see "Quickstart via the Claude Code plugin" at the bottom of this page), the `manta-bus` MCP server is **registered automatically** as part of the plugin. There is **no command to run** — skip straight to the Verify step. (The plugin registers it under the plugin-namespaced name `plugin:manta:manta-bus`; the cast pre-flight knows to look for that.)

### b) Installed from npm — `manta install`

If you got Manta via npm (`npm i -g @tr00x/manta`, or `npx @tr00x/manta`), run:

```
manta install
```

with **no arguments**. It self-registers the bus MCP, resolving `server.cjs` from inside the installed package — **no manual path**. Re-running it is a safe no-op; pass `--force` to re-register.

### c) From source (this walkthrough) — explicit path

**From-source only.** This form points at *this checkout's* freshly-built bus binary, so it works **only inside a git clone** that has completed §1's `pnpm -r build` (which is what produces `packages/manta-bus/dist/bin/server.cjs`). Do **not** use it after an npm/plugin install — the `packages/…` tree does not exist in those artifacts; use (a) or (b) instead.

```
claude mcp add -s user manta-bus -- node "$(pwd)/packages/manta-bus/dist/bin/server.cjs"
```

(The `--` separator passes everything after it as the stdio command + args. Older Claude Code releases used `--command "<cmd>"`; if you're on `claude` < 2.x, use that form instead.)

### Verify (all paths)

```
claude mcp list | grep manta-bus
```

Expected: at least one line containing `manta-bus` (the plugin path shows `plugin:manta:manta-bus`).

If you skip this, the CLI's pre-flight (`runCastCommand` calls `verifyMantaBusRegistered` before spawning) will fail with a friendly `spawn_failed` error pointing back at this step.

## 3. Validate skills

```
node packages/manta-skill-validator/dist/bin/manta-validate-skills.cjs --root .
```

Expected: `27 file(s), 0 error(s), 0 warning(s)` (16 skills + 11 slash commands).

## 4. Run the pre-flight smoke

Cheap (~2 min), no API spend:

```
pnpm --filter @manta/e2e test preflight.test.ts
```

Expected: 3/3 passing.

## 5. Run a real recon-swarm cast

> **Precondition (v1):** `manta cast` must run from **inside a Manta-enabled git checkout** — a repo/worktree that carries the `skills/` directory and is a git repo (the cast does `git worktree add`, and each clone's first action is to load the `manta-as-clone` skill from disk). A from-source checkout (this walkthrough) satisfies it. After `npx @tr00x/manta@latest install` into an *arbitrary* empty dir the bin works but `manta cast` does not — casting from an arbitrary directory isn't supported.

In a repo of your choice (or use the sample fixture in `packages/manta-e2e/tests/fixtures/sample-repo/`):

```
node packages/manta-cli/dist/bin/manta.cjs cast recon-swarm \
    --clones 2 \
    --task "Map every public export in src/" \
    --max-parallel-clones 5
```

Each clone carries an internal per-clone usage budget automatically — Claude Code
is a subscription, so there are no per-clone dollar flags to set.

The CLI:
1. Creates `.manta/worktrees/clone-A` and `.manta/worktrees/clone-B`.
2. Writes per-clone snapshots to `.manta/snapshots/cast-<ts>/`.
3. Spawns two `claude --print` subprocesses, each pointing at its worktree.
4. Ticks the orchestrator while clones are alive.
5. When both clones exit (or after the 25-minute budget), prints `Cast cast-<ts> complete: 2 clone(s).`

## 6. Inspect outputs

- `docs/post-mortems/<date>-cast-<ts>-A.md` — what clone A did, the bus events it emitted, the reason it died.
- `docs/post-mortems/<date>-cast-<ts>-B.md` — same for clone B.
- `docs/zk/*.md` — atomic insights the clones wrote before dying.
- `docs/para/projects.md` — append-only fact log.
- `.manta/worktrees/clone-A/`, `clone-B/` — the actual worktrees, kept for inspection.

## 7. If something goes wrong

- `manta status` — current view of the bus.
- `manta recover` — runs one orchestrator cycle, reaping zombies.
- `manta abort` — mark every live clone DEAD with post-mortems.
- `manta kill <id>` — same for a single clone.

If a worktree won't go away or a lock is stuck, open a GitHub issue with the cast id and `manta status` output.

### Troubleshooting: clone process started but never heartbeats

Manta passes the snapshot path to each clone via the `MANTA_SNAPSHOT_PATH` env var
(plus `MANTA_REPO_ROOT` and `MANTA_CLONE_ID`). The clone is also primed via
`claude --print --append-system-prompt <text> --permission-mode bypassPermissions <prompt>`
with a fixed Manta preamble that loads the `manta-as-clone` skill and instructs
it to heartbeat first. The CLI spawner pre-registers the clone in the Bus
*before* launching the `claude` process (Phase-1 lockdown).

If `manta status` shows clones spawned but never moving past `STARTING`:

1. Run `claude --version` — verify it is ≥ 2.1.132 (the `--append-system-prompt` flag is required).
2. Run `claude mcp list` and verify `manta-bus` is listed as user-scope.
3. Inspect `.manta/state/registry.json`; if a clone record is missing entirely, the spawner failed to pre-register (file an issue with the cast-id from `.manta/casts/`).
4. If you re-run a cast after a previous failure, run `manta recover` first to clean orphaned registry records — `Registry.register` throws on duplicate `clone_id`.

## 8. Known limitations (v1)

What ships now: all 9 cast modes, the `/manta:*` slash commands, a single
subscription-aware usage guardrail (`--max-parallel-clones` — no charges,
cooldown, or dollar budgets), native MCP orchestrator tools (§ "Native MCP
tools"), and full observability (status / inspect / tail / replay /
post-mortems). The honest edges:

- **`manta cast` must run from inside a Manta-enabled git checkout** (carries `skills/`, is a git repo) — see the precondition in §5. Casting from an arbitrary empty directory is not supported.
- **`council` and `decoy` are Aghs-locked** — opt in via `.manta/config/budget.json` (`aghs.unlocked: [...]`) or the `MANTA_UNLOCK_AGHS` env var. `phantom-lance` (recursive self-cast) is intentionally **not** shipped.
- **Windows is untested** — macOS / Linux only.
- **`/manta:*` slash commands collide when cwd = the Manta repo itself** (upstream Claude Code [#14929](https://github.com/anthropics/claude-code/issues/14929)) — see the note under the plugin quickstart below. The `manta` CLI works regardless of cwd.

## Quickstart via the Claude Code plugin (recommended)

The plugin is the primary v1 distribution path — it lights up `/manta:*` commands, surfaces Manta's
skills to your session and to spawned clones, and auto-registers the `manta-bus` MCP server. From
inside Claude Code:

```
/plugin marketplace add https://github.com/tr00x/Manta.git
/plugin install manta@manta-dev
/reload-plugins
```

The marketplace is named `manta-dev` and the plugin inside it is `manta`, so the install spec
(`<plugin>@<marketplace>`) is `manta@manta-dev`. After install, run `/manta:help` for a command tour
or `manta doctor` from a terminal to verify your environment.

Then `/manta:cast recon-swarm --task "Map this codebase"`, watch with `/manta:status`, stop with
`/manta:abort`. The exact `/plugin` strings match current Claude Code docs; if your build differs, run
`/plugin` and follow the in-app flow, or test a local checkout with `claude --plugin-dir .`. Packaging
internals: `docs/internals/plugin-packaging.md`. This walkthrough above is the from-source dev path.

> **`/manta:*` missing when cwd = the Manta repo?** Known Claude Code limitation
> ([#14929](https://github.com/anthropics/claude-code/issues/14929)): with cwd inside this repo, CC
> discovers the repo's own `.claude-plugin/marketplace.json` as a *directory* marketplace, whose slash
> commands silently fail to register. The marketplace is named `manta-dev` (not `manta`) precisely so it
> can't name-collide with the installed `manta` plugin — but the directory-source discovery bug is
> upstream. Contributor workaround: launch from a sibling dir with
> `claude --plugin-dir /path/to/Manta`, or set `"enabledPlugins": { "manta@manta-dev": false }` in
> `~/.claude/settings.json` and use `claude --plugin-dir .`. The `manta` CLI works regardless of cwd.

## Native MCP tools (drive Manta from your orchestrator)

Prefer programmatic, structured tool calls over shelling out to `/manta:*`? The
Manta Bus MCP server also exposes **user/orchestrator tools** — `manta_cast`,
`manta_status`, `manta_cost`, `manta_inspect`, `manta_abort`, `manta_kill` — so a
Claude Code orchestrator can drive Manta natively. They run the same `manta` CLI
under the hood and **complement** (do not replace) the slash commands. `manta_cast`
is non-blocking: it returns the cast id once clones start spawning, then you watch
with `manta_status`. See **[docs/user/mcp-tools.md](./mcp-tools.md)** for the full
list, inputs, and binary resolution.

> **`[manta] not a git repo root`?** Manta's state (registry, charges, worktrees) is **per-repo**, keyed
> on the git root — so the stateful CLI commands (`status`, `cost`, `charges`, `cast`, `cleanup`, …) must
> be run from the **repo root**, not a subdirectory. This is by design (per-repo isolation: a cast in
> project A never leaks into project B). The exception is `manta doctor`, which walks up to find `.git`
> so it can health-check from anywhere. If a command errors with `not a git repo root`, `cd` to the repo
> root and re-run. (Subdirectory upward-resolution for the other commands is a post-`0.1.0` nicety, not a
> bug.)

See the [README](../../README.md) for the big picture and the [mode guides](.) for each cast mode.
