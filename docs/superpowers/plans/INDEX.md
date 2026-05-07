# Manta Implementation Plans — Index

Карта планов реализации Manta. Источник истины по дизайну: `../specs/2026-05-06-manta-pattern-design.md`. Стратегия: **bootstrap-by-manta** (см. spec Sec 15).

## Phase 0 — Foundation (recon-swarm end-to-end)

Цель: production-ready end-to-end `recon-swarm` mode. Solo Claude Code строит без помощи клонов.

| План | Статус | Содержит |
|---|---|---|
| `2026-05-06-phase-0-foundation.md` | **Executed** — Chunk 1 (`73779ae`) + Chunk 2 (`d798e64`) + post-review fixes (`e0285f2`). 49 tests, 97% coverage on `@manta/snapshot`. | Chunk 1 (monorepo bootstrap), Chunk 2 (`@manta/snapshot` package) |
| `2026-05-06-phase-0b-bus.md` | **Executed** — Chunk 1 (`8f6a465`+`5d85012`) + Chunk 1 remediation (`e54d06f`) + Chunk 2 (`81ae195`) + Chunk 2 remediation (`6dc77bc`). 142 tests, 99% coverage on `@manta/bus`. | `@manta/bus` — state foundations (Chunk 1) + MCP server with 18 tools across 6 families (Chunk 2), in-mutex audit-trail invariant, integration test (registry/locks/claims/contracts persistence across restart), README + ARCHITECTURE |
| `2026-05-06-phase-0c-orchestrator.md` | **Executed** — Chunk 1 (`7d48d74`+`e817e77`+`f4cd75f`) + Chunk 1 remediation (`f2091d5`) + Chunk 2 (`0fc93b1`) + Chunk 2 finalize (`4a05d91`). 44 tests, 99.55% statement coverage on `@manta/orchestrator`. | `@manta/orchestrator` — Orchestrator class with `runCycle`/`getStatus`, detection (heartbeat + parent-PID), reapers (lock + claim), post-mortem writer/composer, fs-atomic markdown output, OrchestratorError with reserved kinds. Adds `ClaimsStore.reapExpired` + `BusContext`/`SubsetContext` re-export to `@manta/bus` (committed separately). |
| `2026-05-06-phase-0d-cli.md` | **Approved** — Chunks 1-2 written (~2.5k lines, 79 atomic tasks), reviewer-found-issues fixed | `@manta/cli` — Chunk 1: errors, runtime composer, worktree, snapshot-builder (correct CaptureInput shape: castId/parentSessionId/parentWorktree/cloneWorktree/4-field Budget/ttlSeconds/siblingCloneIds), clone-spawner (CloneRunner seam), tick-loop, status-table, reporter. Chunk 2: 5 commands (cast/status/kill/abort/recover), `bin/manta.ts` with `runWithRuntime` helper + `process.exitCode` pattern, end-to-end integration test exercising orchestrator's death-detection path. |
| `2026-05-06-phase-0e-skills-and-commands.md` | **Approved** — Chunks 1-2 written (~1.5k lines, 54 atomic tasks), reviewer-found issues fixed | Chunk 1: `@manta/skill-validator` package (gray-matter + zod for frontmatter; required H2 sections; CLI bin). Chunk 2: 4 skills + 5 slash commands + integration test. Skill content scopes hooks/charges/fragility to their actual phases; cooldown framed as Phase-0 operator discipline. |
| `2026-05-06-phase-0f-recon-swarm-integration.md` | **Approved** — Chunks 1-2 written, reviewer-found issues fixed | Chunk 1: `@manta/e2e` package — pre-flight smoke (always runs) + env-gated real-claude recon-swarm e2e against a checked-in sample fixture (composite/noEmit fix; Registry public API for assertions). Chunk 2: user docs, acceptance checklist with sign-off, top-level README, CHANGELOG.md (0.1.0 Phase-0 entry per Keep-a-Changelog). |

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
