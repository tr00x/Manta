# Changelog

All notable changes to Manta. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `forking-realities` mode allowlist (Phase 2a — spawn surface only; bus isolation is Phase 2b, merge-review is Phase 2c).
- Cast manifest at `.manta/state/casts/<castId>.json` (mode + roster + policy; idempotent across clones).
- `registry.metadata.cast_mode` (Phase 2b filter join key).
- Per-clone task overlay via `--tasks <yaml|json>` (`manta cast`); `--task` remains the cast-level fallback.
- Asymmetric per-clone budgets — cumulative gate switches from `N×cap` to `Σ(per-clone caps)`.
- `{APPROACH_HINT_BLOCK}` placeholder in the priming preamble (substitutes `Approach hint: …` or empty).
- New runtime dep: `yaml@^2.6` (for `--tasks` parsing).
- Operator-facing doc `docs/user/forking-realities.md`.

## [0.1.0] — Phase 0 (recon-swarm foundation)

### Added

- `@manta/snapshot` — Zod-validated transcript + state serializer with explicit version migrations.
- `@manta/bus` — MCP server exposing the full Manta Bus API (18 tools across 6 families): lifecycle, contract, work-claim, file-locks, communication, memory.
- `@manta/orchestrator` — lifecycle policy: heartbeat / parent-PID death detection, stale-lock and expired-claim reaping, structured post-mortem authoring, idempotent `runCycle()`.
- `@manta/cli` — five Phase-0 commands: `cast`, `status`, `kill`, `abort`, `recover`. `recon-swarm` mode supported end-to-end.
- `@manta/skill-validator` — frontmatter + content validator gating skill / slash-command authoring.
- `@manta/e2e` — pre-flight smoke (always runs) + env-gated real-`claude` recon-swarm e2e.
- Four Phase-0 skill files (`manta-as-clone`, `manta-coordinate`, `manta-graceful-death`, `manta-cast-decide`) and five Phase-0 slash commands (`/manta cast / status / kill / abort / recover`).
- User docs: `docs/user/getting-started.md`, `docs/user/recon-swarm.md`. Per-package `README.md` + `ARCHITECTURE.md` for every production package.
- Acceptance checklist: `docs/acceptance/phase-0.md`.

### Phase-0 non-goals (deferred)

See the spec (`docs/superpowers/specs/2026-05-06-manta-pattern-design.md`) Sec 15.1 for the phase plan. Briefly: forking-realities (Phase 2), charges/cooldowns (Phase 3), Wave-1 closeout (Phase 4), daemon mode (Phase 5), Wave-2 modes (Phase 6), Library + auto-cast (Phase 7), Aghs-locked modes (Phase 8).
