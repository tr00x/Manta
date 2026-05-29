# Last-gasp report — clone-B (cast-1780020786877)

**Task:** Implement Phase 7b Chunk 1 ONLY (Tasks 1.1–1.7 of `docs/superpowers/plans/2026-05-28-phase-7b-manta-share.md`) via TDD. STOP at Chunk 1.
**Mode:** forking-realities · **Sibling:** A · **Outcome:** ✅ task_complete

> Note on task wording: the contract said "Tasks 1.1-1.10", but the plan defines Chunk 1 as **Tasks 1.1–1.7** ("Chunk 1 complete when" sits right after Task 1.7; Task 2.1 begins Chunk 2). I followed the plan's Chunk-1 task list exactly and stopped at Chunk 1 as instructed. Chunk 1 has 7 tasks, not 10.

## Summary

All 7 Chunk-1 tasks implemented production-grade via the plan's Step-by-step TDD (failing test → impl → passing test → commit). The full sanitization data layer now exists: the `castOrigin` manifest extension + `SharedBundleManifestSchema`, the secret-format scanner, and one sanitizer per bundled artifact (snapshot, task-contract, post-mortem, ZK note, events, worktree-diff). 126 Chunk-1 tests are green; `pnpm typecheck` and root `pnpm lint` are clean. The full `pnpm test` is 1251/1252 — the single failure is a **pre-existing, environment-scoped** heartbeat-hook test unrelated to this work (logged as bug #53, proof below).

## Commits made (branch `manta/cast-1780020786877/B`, 7 commits)

| Commit | Task | Title |
|---|---|---|
| `5db641d` | 1.1 | feat(skill-validator): CastOriginSchema + SharedBundleManifest + castOrigin.optional() on MantaPackageManifestSchema |
| `2a87180` | 1.2 | feat(cli): SanitizationWarning type + secret-format scanner for share bundles |
| `d5fb9a0` | 1.3 | feat(cli): snapshot sanitizer — drop transcript/PID/session/budget, redact worktree paths |
| `ff7fb01` | 1.4 | feat(cli): task-contract sanitizer — secret hard-block + path relativisation |
| `087b6ec` | 1.5 | feat(cli): post-mortem markdown sanitizer — header redaction + defense-in-depth scan (amended once for a repoRoot lint fix) |
| `c9ab141` | 1.6 | feat(cli): ZK-note sanitizer — created_at rewrite + body path/secret scan (warn-no-redact) |
| `d3275c1` | 1.7 | feat(cli): event-timeline + worktree-diff sanitizers (per-type projection + secret hard-block) |

(An 8th commit follows this report: the final graceful-death commit of `last-gasp-report.md` + bug-log entry #53.)

26 files changed vs base `1f70b19` (cap was 30).

## Tests added (126 total, all green)

**`@manta/skill-validator` (50 tests across 2 files):**
- `tests/cast-origin-schema.test.ts` (22 new): user-fired/provenance-populated round-trips; URL-not-path repo origin; 10 Mode literals; causeChain max-8 boundary; parentCastId null; triggerName length bounds; non-int firedAtOffsetMs; `.strict` on castOrigin + provenance; semver/datetime/castId validation; `SharedBundleManifestSchema` intersection (+ rejects missing castOrigin, rejects invalid base).
- `tests/manifest-schema.test.ts` (+4 Step-0a regression): every fixture manifest still parses; pre-7b manifest (no castOrigin) parses; manifest with valid castOrigin parses; **castOrigin: null THROWS** (the gated invariant).

**`@manta/snapshot` (7 tests):**
- `tests/sanitized-schema.test.ts`: SanitizedSnapshotSchema parses sanitized output; `<worktree>` literal required; rejects leaked parentSessionId/parentPid/budget/recentMessages/sessionId.

**`@manta/cli` (69 tests across 7 files in `tests/share/`):**
- `secret-scanner.test.ts` (27): table-driven positive+negative per provider, masking never re-leaks, multi-secret blob, canonical AKIA, maskSecret first-4.
- `sanitize-snapshot.test.ts` (9): worktree markers, transcript-drop warning, openFiles relativise/drop, PID/session/budget omitted, schema round-trip.
- `sanitize-task-contract.test.ts` (7): clean passthrough, secret-in-task/approachHint throw, scope path relativise/drop, non-sensitive verbatim.
- `sanitize-post-mortem.test.ts` (9): Worktree redact, PID drop, epoch→offset, Died unknown, Metadata/Event-timeline intact, secret fatal, stray-path masked warn.
- `sanitize-zk-note.test.ts` (6): created_at→bundledAt ISO, frontmatter preserved, path warn-no-redact, secret-in-body/title fatal.
- `sanitize-events.test.ts` (8): broadcast→{event_type}, heartbeat→{state}, unknown→null, ts offset, winning-clone filter, drop-all control events, **drift-guard vs renderEventPayload**.
- `sanitize-worktree-diff.test.ts` (3): clean passthrough, secret fatal, empty diff.

## Gate verification output

`pnpm typecheck` — **PASS** (tsc -b, all packages).
Root `pnpm lint` (`eslint 'packages/**/src/**/*.ts'`, the canonical gate) — **PASS** (0 errors). My new src files lint clean. (The per-package `eslint "tests/**"` reports pre-existing debt in *other* test files; the canonical gate does not lint tests.)
`pnpm test` (full workspace, `vitest run`):
```
Test Files  1 failed | 150 passed (151)
     Tests  1 failed | 1251 passed (1252)
```
The single failure: `packages/manta-cli/tests/spawner/heartbeat-hook.test.ts > touch script updates last_heartbeat_at in registry`.

All 126 Chunk-1 tests pass in isolation:
```
@manta/cli   tests/share/        7 files  69 passed
@manta/skill-validator           2 files  50 passed
@manta/snapshot tests/sanitized-schema.test.ts  7 passed
```

## The one gate failure is NOT mine (bug #53)

- `git diff 1f70b19 --name-only` for this branch touches **only** `packages/manta-cli/src/share/*`, three `manta-skill-validator/src` files, two `manta-snapshot/src` files, and their tests. `spawner/heartbeat-hook.{ts,test.ts}` are byte-identical to base.
- The touch-script logic works in isolation (a manual repro with the same proper-lockfile resolution updated `last_heartbeat_at` to `now` correctly).
- Memory obs 16798 records a green gate ("1150 tests pass") earlier today in the **main repo**. The failure only manifests in this freshly-`pnpm install`ed worktree → environment/hoisting-sensitive resolution of `proper-lockfile` inside the generated `.cjs`, whose lock error is silently swallowed by `catch { return }`.
- Full root-cause + candidate fixes logged in `docs/manta-bugs.md` #53.

## Two deviations from the plan (both fix real plan bugs — documented in commit bodies)

1. **Circular import (Task 1.1).** The plan places `SharedBundleManifestSchema` in `cast-origin-schema.ts` importing `MantaPackageManifestSchema`, while `manifest-schema.ts` imports `CastOriginSchema` — a fatal eval-time cycle (`.optional()`/`.and()` both run at module load). Fix: `cast-origin-schema.ts` imports nothing from manifest-schema; `SharedBundleManifestSchema` lives in `manifest-schema.ts` (which has both halves). Acyclic graph: `manifest-schema → cast-origin`. Both re-exported from the package index; behaviour + acceptance identical.
2. **Test location.** The plan puts tests under `src/share/tests/`, but every package's `vitest.config.ts` has `include: ['tests/**/*.test.ts']` and coverage `include: ['src/**/*.ts']` — tests under `src/share/tests/` would be **invisible to `vitest run`** (gate would pass without running them) and counted as source for coverage. Fix: source in `src/share/` (per plan), tests in `tests/share/` (repo convention + the include glob). Keeps the gate honest.

## Pending / next (Chunk 2 — NOT started, per STOP instruction)

- Chunk 2 (Tasks 2.1–2.5): bundle-assembler + `checksum.json`, `buildCastOrigin` from live cast state, README auto-gen, `manta share` command, bin registration. Chunk 1's sanitizers + `SharedBundleManifestSchema` are the inputs it consumes.
- **For the main:** bug #53 (heartbeat-hook env failure) is worth a quick fix before the next worktree-based cast — the silent `catch { return }` should at least `console.error` so a reddening gate is diagnosable.
- The Chunk-1 sanitizers are pure functions over fixtures; no `manta share` CLI exists yet, so nothing is wired into a command (by design).
