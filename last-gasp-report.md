# Last-gasp report — clone D, cast cast-1779982814933 (Phase 7a Chunk 1)

## Summary

Implemented every Task 1.x of `docs/superpowers/plans/2026-05-28-phase-7a-manta-library.md` Chunk 1 in the documented dependency-chain order, with strict TDD throughout. Twelve atomic commits on `manta/cast-1779982814933/D`:

| Commit | Task | Subject |
|---|---|---|
| `4a9c775` | 1.1 | MantaPackageManifest Zod schema (skill-validator) |
| `5b62e4d` | 1.10 | Post-mortem record.metadata allowlist redactor (bug #18 layer a) |
| `a55bc7a` | 1.2 | ModeRegistry seam |
| `20bb9ee` | 1.3 | manta-lock.json read/write |
| `bf7da8a` | 1.4 | LocalStore for ~/.manta/library + dir-digest |
| `cbcf999` | 1.6-fix | widen IssueCode union (DTS pass fix) |
| (above) | 1.5 | RegistryClient + fixture |
| (above) | 1.6 | validatePackage extension |
| (above) | 1.7 | manta install command (happy path) |
| `0b9a494` | 1.8 | cast.ts ModeRegistry + verifyMantaVersionCompat integration |
| `bacda3b` | 1.9 | docs/user/manta-library.md (Chunk 1 draft) |
| `3f0ebfb` | polish | lint hygiene + type-safety tightening |

Test counts: **67 new tests** added by this chunk; **all green**.
- manifest-schema: 24
- mode-registry: 13
- lockfile: 14
- local-store + dir-digest: 14 + 3
- registry-client: 12
- validate-package: 6
- install: 6
- compat: 5
- cast-library-mode integration: 3
- metadata-allowlist + post-mortem redaction integration: 6 + 1

Workspace exit gate state:

- `pnpm -r build`: green.
- `pnpm -r test`: 1032/1033 pass. The one failure (`tests/spawner/heartbeat-hook.test.ts > touch script updates last_heartbeat_at in registry`) is pre-existing on `main` — verified by re-running the same test against the main worktree before my changes. Not introduced by this cast.
- `pnpm -r lint`: workspace error/warning counts equal main exactly. cli 356/355/1, orchestrator 6/5/1, bus 2/1/1 (all pre-existing); snapshot + skill-validator clean.

## Architectural notes worth surfacing

1. **`directoryDigest` shipped in Chunk 1 lockfile schema, not retrofitted in Chunk 2.** The plan called it out as a reviewer must-fix; I implemented it that way so Chunk 2 task 2.4 (hash-pin verification) is a pure-read addition with no schema migration.
2. **`Runtime.homeDir` override is new.** Node's `os.homedir()` does not always honor the `HOME` env var, so the runtime now exposes an explicit homeDir override that the cast-library-mode integration test uses to sandbox `~/.manta/library/` to a tmp dir. Production paths use the default (`os.homedir()`).
3. **`MANTA_CLI_VERSION` const, not import-meta lookup.** The plan suggested either; I chose the const because the alternative (reading package.json at import-meta-relative path) has subtle ESM-vs-CJS gotchas in tsup's dual build. The const must be bumped alongside `packages/manta-cli/package.json#version` at release time — documented in the file's docblock.
4. **Library mode dispatch routes through `basedOn` by rewriting `opts.mode`.** `runCastCommand` records the library origin via reporter event (`cast.library_mode_resolved`) then continues with the host dispatcher mode for branch selection. This is the minimum integration per the plan; richer per-mode dispatcher overrides are deferred.

## Pending items / non-goals (Chunk 2)

- `manta uninstall`, `manta library list/show/outdated/doctor`.
- Install flag completeness (`--force`, `--offline`, `--integrity`, `--json`, `--dry-run`, `--no-validate`).
- Hash-pin verification on every cast (lockfile field is present; the cast-time read+compare is the Chunk 2 work).
- E2E `MANTA_E2E=1` test.
- INDEX.md row + CHANGELOG entry.

## Self-certainty

9/10. The implementation is coherent, test-driven, and lint-clean against main. The one pre-existing test failure is unrelated and reproducible on `main`. Broadcast attempt for the certainty event failed due to MCP payload schema mismatch with the wrapper; per `manta-as-clone.md` v0.0.5 self-certainty is a tie-breaker and skipping is gracefully handled by the scoring engine.

## Notes for the main

- The fixture sample-package.tgz committed under `packages/manta-cli/tests/fixtures/library/` is deterministic (built with `noMtime: true, portable: true`). Rebuild via `pnpm tsx packages/manta-cli/tests/fixtures/library/build-sample.ts` if the source dir changes.
- `MANTA_CLI_VERSION` is `0.0.0` matching `packages/manta-cli/package.json#version`. When the project ships its first real release tag, both should be bumped together.
- Bug #18 in `docs/manta-bugs.md` updated to status `Partial — layer (a) applied`; layer (b) (full enumeration sanitizer) remains scoped to Phase 7b plan.
