# Manta Implementation Plans — Index

Карта планов реализации Manta. Источник истины по дизайну: `../specs/2026-05-06-manta-pattern-design.md`. Стратегия: **bootstrap-by-manta** (см. spec Sec 15).

## Phase 0 — Foundation (recon-swarm end-to-end)

Цель: production-ready end-to-end `recon-swarm` mode. Solo Claude Code строит без помощи клонов.

| План | Статус | Содержит |
|---|---|---|
| `2026-05-06-phase-0-foundation.md` | **Executed** — Chunk 1 (`73779ae`) + Chunk 2 (`d798e64`) + post-review fixes (`e0285f2`). 49 tests, 97% coverage on `@manta/snapshot`. | Chunk 1 (monorepo bootstrap), Chunk 2 (`@manta/snapshot` package) |
| `2026-05-06-phase-0b-bus.md` | **Executed** — Chunk 1 (`8f6a465`+`5d85012`) + Chunk 1 remediation (`e54d06f`) + Chunk 2 (`81ae195`) + Chunk 2 remediation (`6dc77bc`). 142 tests, 99% coverage on `@manta/bus`. | `@manta/bus` — state foundations (Chunk 1) + MCP server with 18 tools across 6 families (Chunk 2), in-mutex audit-trail invariant, integration test (registry/locks/claims/contracts persistence across restart), README + ARCHITECTURE |
| `2026-05-06-phase-0c-orchestrator.md` | **Executed** — Chunk 1 (`7d48d74`+`e817e77`+`f4cd75f`) + Chunk 1 remediation (`f2091d5`) + Chunk 2 (`0fc93b1`) + Chunk 2 finalize (`4a05d91`). 44 tests, 99.55% statement coverage on `@manta/orchestrator`. | `@manta/orchestrator` — Orchestrator class with `runCycle`/`getStatus`, detection (heartbeat + parent-PID), reapers (lock + claim), post-mortem writer/composer, fs-atomic markdown output, OrchestratorError with reserved kinds. Adds `ClaimsStore.reapExpired` + `BusContext`/`SubsetContext` re-export to `@manta/bus` (committed separately). |
| `2026-05-06-phase-0d-cli.md` | **Executed** — Chunk 1 (`c72ea63`+`c298adc`) + Chunk 1 remediation (`90ee641`) + Chunk 2 review-fix prelude (`1c091e7`) + Chunk 2 (`4864b6f`) + Chunk 2 remediation (`a08d562`). 50 tests, 95.96% statement coverage on `@manta/cli`. | `@manta/cli` — Chunk 1: errors, runtime composer (with `.git` repo-validation), worktree, snapshot-builder (camelCase TaskContract + `deadlineSeconds` per `@manta/snapshot` schema; 4-field Budget), clone-spawner (CloneRunner seam, `terminate` SIGTERM→SIGKILL escalation, surfaced spawn-failure via `CliError(spawn_failed)`), tick-loop (no listener leak across cycles, abort-clean), status-table, reporter. Chunk 2: 5 commands (cast/status/kill/abort/recover), `mcp-preflight` (injectable `ClaudeMcpListRunner` for testability), `bin/manta.ts` with `runWithRuntime` helper + `process.exitCode` pattern, cumulative cost gates (`--budget-per-clone-usd` × `--clones` ≤ `--budget-per-cast-usd`), `--tick-budget-ms` budget abort with handle teardown, partial-failure worktree cleanup, end-to-end integration test exercising orchestrator's death-detection path. |
| `2026-05-06-phase-0e-skills-and-commands.md` | **Executed** — Chunk 1 (`35571c1`) + Chunk 2 (`1596d2c`) + Chunk 2 remediation (`1ddabb0`). 27 tests, 98.78% statement coverage on `@manta/skill-validator`; whole-repo sweep 313/313 green. | `@manta/skill-validator` — Chunk 1: errors, schemas (zod for skill `name`/`description`/`audience: main\|clone\|system`/`version`/`related[]` and command `name: manta:<kebab>`/`description`/`target`/`aliases[]`, both `.strict()`), parse (gray-matter + H2 heading extractor), validate (parse + schema + section composer with severity-tagged issues), walk (discovery with dotfile-skip + `unsafe_path` warning for hostile names), `bin/manta-validate-skills` CLI (`--root`/`--quiet`, exit non-zero on error), folded-in M3 (parse_error propagation test) + M4 (H2.lastIndex one-line WHY comment) from review polish. Chunk 2: 4 skills (`manta-as-clone` clone identity + anti-recursion + anti-gossip; `manta-coordinate` lock/claim/filtered-broadcast etiquette; `manta-graceful-death` TTL/kill/completion paths with exit-code policy; `manta-cast-decide` main-side four-question gate + Phase-0 cost gates + cooldown-as-discipline framing), 5 slash-command files (`/manta cast/status/kill/abort/recover` referencing real `@manta/cli` args, `Orchestrator.runCycle()`, `Registry.markDead`), integration test asserts every Phase-0 file validator-clean and present, README + ARCHITECTURE for `@manta/skill-validator`. Chunk 2 remediation: walker silently skips dotfile entries (e.g. macOS `.DS_Store`) before `unsafe_path` classification, hostile-name fixture rename + new dotfile-skip test, defensive `**/.DS_Store` + `Thumbs.db` in `.gitignore`. |
| `2026-05-06-phase-0f-recon-swarm-integration.md` | **Executed** — Chunk 1 (`fea5d32`) + Chunk 1 remediation (`6c609a1`) + Chunk 2 (`53b9b4b`) + Chunk 2 remediation (`c607b8c`). 4 tests on `@manta/e2e` (3 preflight + 1 env-gated SKIP); whole-workspace sweep 317/317 green. | Chunk 1: `@manta/e2e` — `package.json`/`tsconfig.json` (composite+incremental forced false to satisfy TS5069 with `noEmit`; fixtures excluded so bare-ESM imports don't trip nodenext)/`vitest.config.ts` (30-min testTimeout for real-claude path), sample fixture repo (`auth/billing/logging` cross-imports) for reproducibility, `claudeBin.ts` probe (CLAUDE_BIN env override + ENOENT/timeout/generic diagnostics surface in SKIP reason), `sampleRepo.ts` makes a tmp git repo from the fixture per test, `preflight.test.ts` (always runs: workspace `pnpm -r build`, skill-validator clean, `manta status` on git-init'd tmpdir), `recon-swarm.e2e.test.ts` (env-gated by `MANTA_E2E=1` + `claude --version` ok; spawns 2 real clones, asserts registry DEAD + post-mortems with Event timeline + ZK notes + cast-snapshots + retained worktrees; afterAll cleanup). Chunk 2: `docs/user/getting-started.md` (8-step walkthrough including mandatory `claude mcp add manta-bus`), `docs/user/recon-swarm.md` (mode lifecycle + when-to-use), `docs/acceptance/phase-0.md` (per-package gates + e2e checklist + sign-off block; tightened `rg` check pattern post-review), top-level `README.md` (quickstart with the mcp-add step + 8-phase status table), `CHANGELOG.md` (0.1.0 Phase-0 entry per Keep-a-Changelog). Bug #2 logged in `docs/manta-bugs.md` (skill+doc claim that spawner registers clones before launch is misleading — deferred to Phase 1 lockdown). |

## Phase 1 — `recon-swarm` Production-Grade Lockdown

Цель: закрыть `docs/manta-bugs.md` bugs #2/#3/#4 чтобы Phase-0 GA gate подписать. Solo (последняя solo-фаза перед bootstrap-by-Manta).

| План | Статус | Содержит |
|---|---|---|
| `2026-05-07-phase-1-recon-swarm-lockdown.md` | **Executed** — Chunk 1 (`57551ef`) + dogfood-driven follow-ups (current commit). Two real-claude casts green: 4m36s wallclock (first), 4m21s (re-run); both clones DEAD with post-mortems, watcher fired green. New bug #5 (clones don't write ZK notes consistently — 0 first run, 1 second) tracked Open / Medium for Phase-2. | Chunk 1: spawner pre-registration via `runtime.ctx.registry.register({ clone_id, mode, parent_pid, worktree, metadata })`, replace `--snapshot` with `--append-system-prompt <text> --permission-mode bypassPermissions <prompt>`, behavioural-fixture test (state STARTING → non-STARTING signal, NOT `last_heartbeat_at`), e2e positive timeline assertion (`tickBudgetMs / 4`), skill+slash-command+doc text alignment, dogfood + bug-log + acceptance updates, post-mortem |

## Phase 2 — `forking-realities` Production-Ready

Цель: production-grade `forking-realities` mode — worktree-based isolation, best-of-N flow, `manta-merge-review`, Tier 3-4 observability (`tail`, `replay`, `audit`). Build by **partial dogfood**: Phase 0/1 рабочий `recon-swarm` используется для исследования best-of-N patterns + map текущей кодовой базы под форк-точки.

| План | Статус | Содержит |
|---|---|---|
| `2026-05-07-phase-2-forking-realities-research-prep.md` | **TODO — research prep** | Cast spec для recon-swarm: 3 клона (codebase map / best-of-N research / Bus isolation strategy). Output feeds Phase 2 plan. |
| `2026-05-07-phase-2-forking-realities.md` | **TBD — pending research cast** | Будет написан после post-mortem'а recon-swarm каста. Ожидаемый scope: spawner-N-worktrees, manta-merge-review skill+command, plagiarism-prevention bus filter (Sec 5.8), Tier 3-4 observability commands. |

## Phase 3+ — TBD

Per spec Sec 15.1. Each phase = separate plan file:
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
