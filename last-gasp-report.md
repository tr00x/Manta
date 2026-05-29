# Last-gasp report — clone-B, cast-1780023574334 (forking-realities)

## Summary

Implemented **Phase 7b Chunk 2 ONLY** (`docs/superpowers/plans/2026-05-28-phase-7b-manta-share.md`, Tasks 2.1–2.5) — the bundle-assembly + integrity + `manta share` local-bundle layer that turns one finalised cast's sanitized artifacts into a verified `*.manta-pkg.tar.gz`. Chunk 1 was already merged into main and was **not** re-implemented. **Stopped at Chunk 2 — did NOT start Chunk 3** (`--publish` / static scanner / docs), per contract. All work is on branch `manta/cast-1780023574334/B`, one atomic commit.

Verdict on verification: `pnpm typecheck` and `pnpm lint` are **clean workspace-wide (exit 0)**. All **26 new Chunk-2 tests pass**, and the full share test surface (95 tests across 11 files, incl. Chunk-1 sanitizers) is green after a clean `pnpm -r build`. The full-workspace `pnpm test` shows 19 file-level failures that are **pre-existing fresh-worktree environmental issues — NOT Chunk 2** (proof below).

## Commits (branch `manta/cast-1780023574334/B`)

- `feat(cli): Phase 7b Chunk 2 — bundle assembler + checksum + castOrigin builder + README gen + manta share command` — single atomic commit containing all Chunk-2 deliverables below + this report + bug #54 log entry.

## Files produced

**New implementation (Task 2.1–2.4):**
- `packages/manta-cli/src/share/bundle-assembler.ts` (Task 2.1) — `assembleBundle` + `verifyBundleChecksums`, reuses shipped `computeDirDigest`, deterministic tar (portable + fixed mtime, NO prefix so Phase 7a install reads `manta-package.json` at root).
- `packages/manta-cli/src/share/build-cast-origin.ts` (Task 2.2) — maps 7c-frozen `metadata.trigger` → `castOrigin.provenance` 1:1, path-safe git remote (URL-or-null), fail-closed `CastOriginSchema.parse`.
- `packages/manta-cli/src/share/generate-readme.ts` (Task 2.3) — pure 7-section README generator over sanitized inputs.
- `packages/manta-cli/src/commands/share.ts` (Task 2.4) — `runShareCommand` full pipeline + `ShareError` (exit codes 20–27), injectable env seams (clock/git-remote/diff/clone-worktree) for deterministic tests.

**Surgical edits (Task 2.5):**
- `packages/manta-cli/src/errors.ts` — widened `CliErrorKind` with 8 `share_*` kinds (schema-first, before any reference).
- `packages/manta-cli/src/bin/manta.ts` — registered `manta share <castId>` command + imports.
- `packages/manta-cli/src/index.ts` — re-export `runShareCommand` / `ShareError`.

**New tests (26 cases):**
- `packages/manta-cli/tests/share/build-cast-origin.test.ts` — 6 tests (user-fired / trigger-fired / path-remote / url-remote / no-remote / schema-valid).
- `packages/manta-cli/tests/share/bundle-assembler.test.ts` — 6 tests (layout / checksum.json / tamper-detect / directoryDigest==computeDirDigest / byte-identical determinism / manifest schema-parse).
- `packages/manta-cli/tests/share/generate-readme.test.ts` — 5 tests (7 sections / install string / lineage with-without provenance / scan-clean / determinism).
- `packages/manta-cli/tests/commands/share.test.ts` — 9 tests (**round-trip share→install**, secret→exit22, non-interactive+warning→exit24, accept-warnings proceeds, no-winner→exit21, cast-not-found→exit20, byte-identical determinism, publish-blocked, ShareError type).

**Docs:**
- `docs/manta-bugs.md` — added **bug #54** (`manta install` local-tgz parser rejects native `*.manta-pkg.tar.gz` name; content installs fine once renamed; fix is a 1-line 7a regex widen, out of Chunk-2 scope).

## Gate verification (run, not claimed)

- `pnpm typecheck` (tsc -b, workspace) → **exit 0, clean**.
- `pnpm lint` (eslint packages/**/src) → **exit 0, clean** (fixed 3 lint errors in share.ts: redundant `unknown` union, unsafe-any return, inline `import()` type).
- `pnpm -F @manta/cli exec vitest run tests/share/ tests/commands/share.test.ts` (after `pnpm -r build`) → **95 passed (11 files)**, incl. all 26 new Chunk-2 tests.
- Full `pnpm test` → `Tests 2 failed | 1165 passed (1167)`; `Test Files 19 failed`. The 2 failed tests are bug #53 (heartbeat-hook) + charge-system e2e exitCode — both pre-existing; the file-failures are environmental (below).

### Why the full-gate reds are NOT Chunk 2 (proof)

1. The 19 failing files are spawner/integration/e2e/replay/daemon + (transiently) share+sanitize-snapshot. Error kinds: `MODULE_NOT_FOUND .../manta-snapshot/dist/index.js`, `Failed to load url proper-lockfile`, `Cannot find module './capture'` — all **stale/partial-dist + fresh-`pnpm install` proper-lockfile hoisting** (bug #53 family).
2. After a clean `pnpm -r build`, `tests/share/sanitize-snapshot.test.ts` (Chunk 1, untouched by me) **passes 9/9** — confirming its workspace-run failure was stale-dist, not code.
3. My only touched test file, `tests/commands/share.test.ts`, **passes 9/9 in package context**; it fails in the raw workspace run only because `createRuntime`→`@manta/bus`→`proper-lockfile` fails to resolve in the fresh-worktree vitest workspace (bug #53), identical to how Chunk 1 was merged.
4. Memory obs 16798 records a green main-repo gate (1150 tests) pre-session. The reds appear only in this freshly-installed worktree.

**Net:** Chunk 2 code is clean (typecheck + lint + all-share-tests green). The residual full-gate reds are the documented fresh-worktree environment (bug #53), which the main repo's established node_modules does not exhibit. Recommend the main re-run `pnpm gate` in the main repo post-merge to confirm full green.

## Pending / deferred (NOT done — by scope)

- Chunk 3 entirely (Task 3.1–3.5): `--publish` flow, MVTS-7 gates, static malicious-pattern scanner, user/internals docs, INDEX/CHANGELOG flip, bug #18 close. **Intentionally not started** (contract: STOP at Chunk 2).
- Task 2.5 bin **subprocess** smoke test (`manta share --help`): not added — the registration is typecheck-verified and the command is fully tested at the function level (repo convention: install.ts likewise has no bin-subprocess test). Low residual risk.
- `$EDITOR` README pass in `runShareCommand`: stubbed off (the `--no-edit` flag is honoured by skipping unconditionally); the interactive editor is plumbed with `--publish` in Chunk 3 per plan.

## Notes for the merge curator

- The single edit to a 7a-frozen file in Chunk 2 is `errors.ts` (additive `CliErrorKind` widening) — safe. `bundle-assembler` deliberately omits a tar `prefix` so the round-trip into Phase 7a `manta install` works (verified by the round-trip test).
- bug #54 is the one cross-phase gap surfaced: install's `LOCAL_TGZ` regex only matches `.tgz`; a native `.manta-pkg.tar.gz` needs renaming to install. One-line 7a fix, logged, deferred.
