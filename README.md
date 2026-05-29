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

- [x] Phase 0 — `recon-swarm` foundation
- [ ] Phase 1 — `recon-swarm` production-grade lockdown
- [~] Phase 2a — `forking-realities` spawn surface (allowlist + per-clone tasks file + cast manifest); bus isolation (2b) + merge-review (2c) + observability (2d) pending. See `docs/user/forking-realities.md`.
- [ ] Phase 3 — Charge system + budgets + cooldowns
- [ ] Phase 4 — Wave-1 closeout (`refactor-wave`, `bug-hunt`)
- [ ] Phase 5 — Daemon-mode runtime
- [ ] Phase 6 — Wave-2 modes
- [ ] Phase 7 — Manta Library + auto-cast triggers
- [ ] Phase 8 — Aghanim's-locked modes (`council`, `phantom-lance`, `decoy`)

## License

MIT — see `LICENSE`.
