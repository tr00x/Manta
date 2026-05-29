# Changelog

All notable changes to Manta. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-05-29

First published `manta` release. `0.1.0` is the first real npm publish of the unscoped `manta` CLI; it contains all internal work Phases 0–7 (the earlier `[0.1.0] — Phase 0` heading was an internal milestone marker — every package was `private`/`0.0.0` and nothing reached npm). Honest-early version per the v1 release decision: the D5 precondition (`manta cast` runs from a Manta-enabled checkout) and the >2 MB transcript degrade-to-empty caveat are real young-software limits, so `0.1.0` rather than `1.0.0`.

### Added — Phase 7b (Manta Share)

- `manta share <cast-id>` — builds a publishable `*.manta-pkg.tar.gz` from a finalised cast (round-trips into Phase 7a `manta install`).
- Flags: `--name` / `--version` (required), `--clone <id>` / `--out <dir>` / `--description` / `--author` / `--license` / `--manta-version-compat` / `--no-edit` / `--accept-warnings` / `--non-interactive`.
- `manta share --publish` — npm publish behind MVTS-7 gates (static scan, checksum re-verify, `npm whoami`, scope-ownership, two human confirmations, 5 MB size cap), plus `--max-bytes <n>`. Interactive only.
- `CastOriginSchema` + `SharedBundleManifest` (additive `castOrigin` extension to the frozen flat manifest; carries cast lineage + Phase 7c trigger provenance, read defensively).
- Full default-deny sanitization pipeline: snapshot, task-contract, post-mortem markdown, ZK notes, event timeline, worktree-diff — allowlist-driven, schema-first, fails closed on new source fields.
- Secret-format scanner (AWS / OpenAI-Anthropic / GitHub / Slack / Google / private-key / JWT / generic `KEY=`) — hard-block on match (fatal, no `--accept`).
- `checksum.json` bundle integrity (per-file sha256 + `computeDirDigest` directory hash; deterministic byte-identical tarballs).
- Static malicious-pattern scanner for bundled JS (advisory warnings + hard-block exceptions; regex v1, AST hardening deferred to Phase 8).
- `docs/user/manta-share.md` + `docs/internals/share-sanitization.md`.

### Fixed — Phase 7b

- Bug #18 (full — layer b): every free-form field across every bundled artifact (snapshot / task-contract / post-mortem / ZK / event-timeline / worktree-diff) is now allowlist-sanitized before a byte leaves the repo. Completes the layer-a metadata allowlist shipped in Phase 7a.

### Deferred to later phases (Phase 7b non-goals)

- Code signing / signature verification — Phase 8+ (no key registry / revocation / rotation infra).
- Author reputation surfacing — Phase 8+ (no telemetry backend or privacy story).
- Runtime sandbox for cast-time mode execution — indefinite (the dispatched clone has full shell access; sandboxing only the dispatcher is theater).
- Auto-**publish** (a trigger fires `npm publish`) — never (policy): triggers may build a bundle, a human always publishes.

### Added — Phase 7a (Manta Library)

- `manta install <spec>` — install a Manta library package. Supports three spec forms: scoped npm (`@manta-library/<name>[@<range>]`), git URLs (`git+https://…[#ref]`), and local tarballs (`./pkg.tgz`). Full flag matrix: `--force` (overwrite collision), `--offline` (refuse network), `--integrity sha256-<base64>` (pre-pinned tarball hash), `--json` (machine-readable summary), `--dry-run` (pipeline through validation; no commit), `--no-validate` (CI replay; warns loudly), `--no-hooks` (hard-refuse; hooks distribution deferred to Phase 8).
- `manta uninstall <name>[@<version>]` — remove an installed package. Multi-version check (refuses without `@<version>` when >1 installed); in-use check (refuses when a non-DEAD clone is running a mode contributed by the package); `--force` covers the soft non-DEAD states (`IDLE`/`WAITING_FOR_TASK`/`WINDING_DOWN`) only, never the hot states (`STARTING`/`WORKING`/`BLOCKED`).
- `manta library list|show|outdated|doctor` — read-only observability subcommands. `list` tables the install set; `show` pretty-prints one package's manifest + lockfile entry; `outdated` reports newer-version-satisfying-range candidates per npm-resolved package; `doctor` runs `validatePackage` + compat check across the install set (exit 20 `library_unhealthy` on failure — distinct from exit 19 tamper).
- `MantaPackageManifest` Zod schema (in `@manta/skill-validator`) — strict validation of library packages; `contributes` table cross-checked against disk (no drive-bys, no danglers).
- `ModeRegistry` (`@manta/cli`) — single seam for built-in + library-installed modes. `has()` is the only mode-validity predicate; library entries register against the host dispatcher named by `basedOn` (closed enum, threat-model-bounded). Name collisions (library/library, library/builtin) hard-fail with `ModeConflictError`.
- `manta-lock.json` at repo root — atomic read/write under `proper-lockfile`, deterministic key ordering (alphabetical packages, sorted contributes arrays, trailing newline). Schema-version 1. Carries `directoryDigest` per entry for the per-cast hash-pin check.
- Global library store at `~/.manta/library/<scope>/<name>/<version>/` with `~/.manta/library/index.json`. Multi-version coexistence by design.
- `verifyMantaVersionCompat` preflight in `manta cast` — exit 16 `manta_version_compat_unmet` with a three-option recovery message (upgrade CLI / install older package / uninstall).
- **Hash-pin verification on every `manta cast`** — exit 19 `library_tampered` on directory-digest mismatch (or `actual: <missing>` when the install dir vanished). Recovery hint: `manta install <name>@<version> --force` to re-fetch. Reuses `computeDirDigest`; ordering: load-registry → compat → integrity → mode-lookup so the operator sees the upgrade message before the tamper message before the unknown-mode message.
- `docs/user/manta-library.md` — full user-facing reference (install, uninstall, library subcommands, flag matrix, hash-pin behaviour, lockfile schema, mode resolution at cast time, troubleshooting table with exit codes 0/11/12/13/14/15/16/18/19/20).
- `docs/internals/mode-registry.md` — architecture note explaining the `basedOn` host-dispatcher inheritance model, the cast-manifest dual recording (`mode` + `libraryMode`), and why the richer `createDispatcher` registry was deferred.

### Fixed — Phase 7a

- Bug #18 (partial — layer a): post-mortem `record.metadata` is now allowlisted to `cast_id` and `cast_mode` only. Non-allowlisted keys are dropped with a single-line audit footer (`@manta/orchestrator/sanitize/metadata-allowlist`). The full enumeration sanitizer (snapshot, contract, timeline, ZK redaction pipeline — clone-A §4.3 + clone-C §1.4 tables) ships in Phase 7b.

### Deferred to later phases (Phase 7a non-goals)

- `manta share <cast-id>` — Phase 7b. Reuses the Phase 7a manifest schema + sanitizer + lockfile.
- `manta trigger add|list <event> <action>` — Phase 7c.
- Hook distribution from library packages — Phase 8 (the `--no-hooks` flag exists with hard-refuse semantics so the flip is a one-line change later).
- Code signing, author reputation, runtime sandbox — Phase 8+.
- Custom HTTP registry — Phase 8+ (only triggered if ≥100 published packages or a supply-chain incident).
- `manta library search` + curated GitHub index — Phase 8.

### Added — Phase 2 (forking-realities + merge-review)

- Merge-review scoring engine + `/manta promote` command (Phase 2c). After a forking-realities cast, the CLI auto-collects metrics (test pass/fail, coverage delta, diff size, complexity, tsc errors, lint) per candidate, scores them with a composite weighted metric, and writes `docs/merge-reviews/<castId>.md`. Operator promotes the winner via `manta promote <castId>/<cloneId>` — merges the branch, graveyards losers.
- Agentic rubric pre-pass: reads `tsconfig.json`, `.eslintrc.*`, `vitest.config.ts` to adjust scoring weights per-cast. Auditable weight adjustments in the merge-review document.
- Self-certainty tie-breaker: forking-realities clones broadcast confidence scores (`self_certainty` event type) used as tertiary tie-breaker within ε noise band.
- Cross-candidate ZK harvest: convergent rewrites (files changed by 2+ clones) surfaced as ZK notes tagged `loser-insights`.
- `manta-merge-review` skill (main-side) + `/manta promote` slash command.
- Graveyard helper: `moveWorktreeToGraveyard` moves loser worktrees to `.manta/graveyard/<castId>-<cloneId>/` with `info.json` sidecar.
- `docs/internals/merge-review-scoring.md` — weight rationale, agentic rubric, tie-breaking chain.
- `forking-realities` mode allowlist (Phase 2a — spawn surface only; bus isolation is Phase 2b, merge-review is Phase 2c).
- Cast manifest at `.manta/state/casts/<castId>.json` (mode + roster + policy; idempotent across clones).
- `registry.metadata.cast_mode` (Phase 2b filter join key).
- Per-clone task overlay via `--tasks <yaml|json>` (`manta cast`); `--task` remains the cast-level fallback.
- Asymmetric per-clone budgets — cumulative gate switches from `N×cap` to `Σ(per-clone caps)`.
- `{APPROACH_HINT_BLOCK}` placeholder in the priming preamble (substitutes `Approach hint: …` or empty).
- New runtime dep: `yaml@^2.6` (for `--tasks` parsing).
- Operator-facing doc `docs/user/forking-realities.md`.

### Added — Phase 0 (recon-swarm foundation)

- `@manta/snapshot` — Zod-validated transcript + state serializer with explicit version migrations.
- `@manta/bus` — MCP server exposing the full Manta Bus API (25 tools across 6 families): lifecycle, contract, work-claim, file-locks, communication, memory.
- `@manta/orchestrator` — lifecycle policy: heartbeat / parent-PID death detection, stale-lock and expired-claim reaping, structured post-mortem authoring, idempotent `runCycle()`.
- `@manta/cli` — five Phase-0 commands: `cast`, `status`, `kill`, `abort`, `recover`. `recon-swarm` mode supported end-to-end.
- `@manta/skill-validator` — frontmatter + content validator gating skill / slash-command authoring.
- `@manta/e2e` — pre-flight smoke (always runs) + env-gated real-`claude` recon-swarm e2e.
- Four Phase-0 skill files (`manta-as-clone`, `manta-coordinate`, `manta-graceful-death`, `manta-cast-decide`) and five Phase-0 slash commands (`/manta cast / status / kill / abort / recover`).
- User docs: `docs/user/getting-started.md`, `docs/user/recon-swarm.md`. Per-package `README.md` + `ARCHITECTURE.md` for every production package.
- Acceptance checklist: `docs/acceptance/phase-0.md`.

### Phase-0 non-goals (deferred)

See the spec (`docs/superpowers/specs/2026-05-06-manta-pattern-design.md`) Sec 15.1 for the phase plan. Briefly: forking-realities (Phase 2), charges/cooldowns (Phase 3), Wave-1 closeout (Phase 4), daemon mode (Phase 5), Wave-2 modes (Phase 6), Library + auto-cast (Phase 7), Aghs-locked modes (Phase 8).
