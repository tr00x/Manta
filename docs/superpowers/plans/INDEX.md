# Manta Implementation Plans — Index

Карта планов реализации Manta. Источник истины по дизайну: `../specs/2026-05-06-manta-pattern-design.md`. Стратегия: **bootstrap-by-manta** (см. spec Sec 15).

## Phase 0 — Foundation (recon-swarm end-to-end)

Цель: production-ready end-to-end `recon-swarm` mode. Solo Claude Code строит без помощи клонов.

| План | Статус | Содержит |
|---|---|---|
| `2026-05-06-phase-0-foundation.md` | **In progress** — Chunks 1-2 written + reviewer-approved + fixes applied | Chunk 1 (monorepo bootstrap), Chunk 2 (`@manta/snapshot` package) |
| `2026-05-06-phase-0b-bus.md` | TODO (next session) | `@manta/bus` — MCP server extension over claude-peers, full Manta Bus API (Sec 4) |
| `2026-05-06-phase-0c-orchestrator.md` | TODO | `@manta/orchestrator` — heartbeat tracking, dead-clone cleanup, post-mortem trigger, append-only event log |
| `2026-05-06-phase-0d-cli.md` | TODO | `@manta/cli` — `cast`, `status`, `kill`, `abort`, `recover` commands |
| `2026-05-06-phase-0e-skills-and-commands.md` | TODO | 4 skills (`manta-as-clone`, `manta-coordinate`, `manta-graceful-death`, `manta-cast-decide`) + `/manta` slash commands |
| `2026-05-06-phase-0f-recon-swarm-integration.md` | TODO | End-to-end integration test on Manta repo itself, smoke verification, docs |

## Phase 1+ — TBD

Per spec Sec 15.1. Each phase = separate plan file:

- Phase 1: `recon-swarm` production-grade lockdown (smoke on real repo, observability tier 0-2 enforced)
- Phase 2: `forking-realities` (worktree-based isolation, best-of-N, manta-merge-review)
- Phase 3: Charge system + multi-layer budgets + cooldowns (built using forking-realities for impl alternatives)
- Phase 4: Wave-1 closeout (`refactor-wave`, `bug-hunt`)
- Phase 5: daemon-mode runtime (Wave-2 prerequisite)
- Phase 6: Wave-2 modes (`pair-programming`, `test-storm`, `documentation-chase`)
- Phase 7: Manta Library + auto-cast triggers + community
- Phase 8: Aghs-locked modes (`council`, `phantom-lance`, `decoy`)

## Naming convention

`YYYY-MM-DD-phase-<N><letter?>-<slug>.md`

`<letter>` for sub-plans within a phase (a/b/c…). Phase 0 has 0a-0f because foundation has 4 packages + skills + integration; later phases may have just one file each.

## Quality gates per plan

Per `CLAUDE.md` and spec Sec 14:
- Test coverage ≥ 80% on critical paths
- TDD discipline: failing test → run → implement → run → commit
- No `// TODO: implement` in merged code
- Atomic commits, conventional commit messages
- Each plan ships with user-facing docs + architecture note for the package/feature it produces
- Plan reviewer subagent approved per chunk before execution

## Execution path

After a plan is fully written + reviewer-approved:
1. Commit the plan file
2. Use `superpowers:subagent-driven-development` (preferred — fresh subagent per task + two-stage review)
3. Track via TaskCreate / TaskUpdate (one task per plan task)
4. Update relevant memory + post-mortems after execution
