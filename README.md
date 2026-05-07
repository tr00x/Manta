# Manta

Self-cloning Claude Code pattern. Same system prompt, full transcript inheritance, parallel work without role specialization. See `docs/superpowers/specs/2026-05-06-manta-pattern-design.md` for the full design.

## Phase 0 — Try it

```
git clone <manta-repo> && cd manta
pnpm install && pnpm -r build
node packages/manta-cli/dist/bin/manta.cjs cast recon-swarm --clones 2 --task "Map this codebase"
```

Full walkthrough: `docs/user/getting-started.md`. Acceptance checklist: `docs/acceptance/phase-0.md`.

## Status

- [x] Phase 0 — `recon-swarm` foundation (this commit)
- [ ] Phase 1 — `recon-swarm` production-grade lockdown
- [ ] Phase 2 — `forking-realities`
- [ ] Phase 3 — Charge system + budgets + cooldowns
- [ ] Phase 4 — Wave-1 closeout (`refactor-wave`, `bug-hunt`)
- [ ] Phase 5 — Daemon-mode runtime
- [ ] Phase 6 — Wave-2 modes
- [ ] Phase 7 — Manta Library + auto-cast triggers
- [ ] Phase 8 — Aghanim's-locked modes (`council`, `phantom-lance`, `decoy`)

## License

MIT — see `LICENSE`.
