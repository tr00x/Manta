# Manta

Self-cloning Claude Code pattern. Same system prompt, full transcript inheritance, parallel work without role specialization. See `docs/superpowers/specs/2026-05-06-manta-pattern-design.md` for the full design.

## Install

Manta is distributed as an **npm CLI** (`npx manta@latest install` registers the `manta-bus` MCP server from the installed path). A Claude Code plugin-marketplace entry is Phase 8, not the v1 mechanism.

```
npx manta@latest install
manta cast recon-swarm --clones 2 --task "Map this codebase"
```

> **Precondition (v1):** `manta cast` runs from **inside a Manta-enabled git checkout** that carries the `skills/` directory (e.g. a clone of this repo). Casting from an arbitrary empty directory is Phase 8.

Working from a source checkout instead:

```
git clone <manta-repo> && cd manta
pnpm install && pnpm -r build
claude mcp add -s user manta-bus -- node "$(pwd)/packages/manta-bus/dist/bin/server.cjs"
node packages/manta-cli/dist/bin/manta.cjs cast recon-swarm --clones 2 --task "Map this codebase"
```

Without the bus registration (either `manta install` or the manual `claude mcp add`) every clone fails at the bus transport. Full walkthrough: `docs/user/getting-started.md`.

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

**v1 release work (toward first npm publish):** transcript inheritance is live — clones boot via forked-transcript `claude --resume`, inheriting the caster's full context rather than running as fresh subagents (RB#1, bug #56 Fixed; acceptance gate `packages/manta-e2e/tests/transcript-inheritance.e2e.test.ts`). The self-contained publish path (single-artifact `tsup` bundle + `manta install` self-bootstrap) is merged (RB#2 Chunks 0–3).

## License

MIT — see `LICENSE`.
