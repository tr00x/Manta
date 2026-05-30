# Manta

Self-cloning Claude Code pattern. Same system prompt, full transcript inheritance, parallel work without role specialization. See `docs/superpowers/specs/2026-05-06-manta-pattern-design.md` for the full design.

## Install

Manta ships two ways. The **Claude Code plugin** is the primary path — it lights up `/manta:*`
commands, surfaces Manta's skills to your session (and to spawned clones), and auto-registers the
`manta-bus` MCP server with zero extra steps. The **npm CLI** is the terminal / power-user path.

### Plugin (recommended)

From inside Claude Code:

```
/plugin marketplace add tr00x/Manta
/plugin install manta@manta
/reload-plugins
```

> The exact `/plugin` argument strings above match current Claude Code behaviour (verified against the
> official docs). If your build differs, run `/plugin` (or `/plugin marketplace add --help`) and follow
> the in-app flow. You can also test a local checkout without a marketplace: `claude --plugin-dir .`
> from the repo root, then `claude plugin validate .` to check the manifest.

On enable you get:

- **`/manta:cast`, `/manta:status`, `/manta:abort`, `/manta:cost`** (plus `kill`/`promote`/`recover`) —
  thin wrappers around the bundled `manta` binary.
- **Manta's skills** in your skill list (e.g. `manta-cast-decide`), and resolvable by spawned clones.
- **The `manta-bus` MCP server**, registered automatically via the plugin's `.mcp.json` — no
  `claude mcp add`, no `manta install`.

### npm CLI (power-user / terminal)

```
npx manta@latest install        # registers the manta-bus MCP server from the installed path
manta cast recon-swarm --clones 2 --task "Map this codebase"
```

> **Precondition (npm path):** `manta cast` runs from **inside a Manta-enabled git checkout** that
> carries the `skills/` directory (e.g. a clone of this repo). The plugin path does not have this
> precondition — its skills ship with the plugin.

Working from a source checkout instead:

```
git clone <manta-repo> && cd manta
pnpm install && pnpm -r build
claude mcp add -s user manta-bus -- node "$(pwd)/packages/manta-bus/dist/bin/server.cjs"
node packages/manta-cli/dist/bin/manta.cjs cast recon-swarm --clones 2 --task "Map this codebase"
```

Full walkthrough: `docs/user/getting-started.md`. Plugin packaging internals: `docs/internals/plugin-packaging.md`.

## Status

Published as `manta@0.1.0` — internal work Phases 0–7 (see `CHANGELOG.md`). All 7 built-in modes operational; 25 MCP tools across 6 families on the bus.

- [x] Phase 0 — `recon-swarm` foundation
- [x] Phase 1 — `recon-swarm` production-grade lockdown
- [x] Phase 2 — `forking-realities` (spawn surface + bus isolation + merge-review + observability). See `docs/user/forking-realities.md`.
- [x] Phase 3 — Charge system + budgets + cooldowns (`manta charges` / `manta cost` / `manta limit`)
- [x] Phase 4 — Wave-1 closeout (`refactor-wave`, `bug-hunt`)
- [x] Phase 5 — Daemon-mode runtime (`manta daemon` / `manta retask` / `manta feedback`)
- [x] Phase 6 — Wave-2 modes (`pair-programming`, `test-storm`, `documentation-chase`)
- [~] Phase 7 — Manta Library (`manta install`/`uninstall`/`library`, 7a) + Manta Share (`manta share`, 7b) shipped; auto-cast triggers (7c) — backend seam built, runtime wiring deferred
- [ ] Phase 8 — Aghanim's-locked modes (`council`, `phantom-lance`, `decoy`) — deferred behind the 90-day prod gate

**v1 release work (toward first npm publish):** transcript inheritance is live — clones boot via forked-transcript `claude --resume`, inheriting the caster's full context rather than running as fresh subagents (RB#1, bug #56 Fixed; acceptance gate `packages/manta-e2e/tests/transcript-inheritance.e2e.test.ts`). The self-contained publish path (single-artifact `tsup` bundle + `manta install` self-bootstrap) is merged (RB#2 Chunks 0–3). The **Claude Code plugin** is the v1 discoverability mechanism (RB#3): manifests, `/manta:*` commands, `.mcp.json` auto-bus, and skills ship in the plugin payload — see `docs/internals/plugin-packaging.md`.

## License

MIT — see `LICENSE`.
